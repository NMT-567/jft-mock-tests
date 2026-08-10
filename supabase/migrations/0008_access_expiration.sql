-- NMT CBT — Student access expiration + bulk management (admin spec).
--
-- INSPECTED BEFORE WRITING ANYTHING (per the spec's own §29/§30):
-- public.users already has the one column that matters for authorization
-- — `status` ('pending'/'active'/'disabled') — and every real access
-- decision in this project already funnels through ONE function:
-- public.is_active_user(uid), which public.has_test_access(uid,tid) calls,
-- which tests_select_authorized/attempts_insert_own RLS (0001_init.sql)
-- and get_exam_content() (0003_hide_answer_key.sql) all call in turn.
-- That means expiration needs exactly ONE new enforcement point — inside
-- is_active_user() itself — for it to be real, unbypassable, and already
-- wired into every existing authorization path with zero RLS-policy
-- changes anywhere else. No duplicate "access_status" table/column is
-- introduced — EXPIRED is always derived from access_expires_at vs now(),
-- never stored redundantly, which is what the spec's own §20 explicitly
-- warns against ("must not depend on a scheduled job having run").
--
-- MIGRATION SAFETY (§30): the two new columns on public.users default to
-- NULL, and NULL means "no expiration" everywhere this reads them (see
-- is_active_user() below). Every existing student's access_expires_at is
-- NULL after this migration runs — nobody's access changes at all.

alter table public.users
  add column access_started_at timestamptz,
  add column access_expires_at timestamptz; -- null = no expiration (unlimited)

alter table public.invited_students
  add column access_expires_at timestamptz; -- null = no expiration; copied onto the real users row at first sign-in below, ONCE — see handle_new_auth_user()

-- ---------------------------------------------------------------------
-- THE enforcement point. Only change: add the expiration check. Every
-- existing caller (has_test_access, tests_select_authorized,
-- attempts_insert_own, get_exam_content) is unaffected in shape — they
-- already call this function and get a plain boolean back.
-- ---------------------------------------------------------------------
create or replace function public.is_active_user(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.users u
    where u.id = uid
      and u.status = 'active'
      and u.email_verified = true
      and (u.access_expires_at is null or u.access_expires_at > now())
  );
$$;

-- ---------------------------------------------------------------------
-- Harden the self-update policy: a student can update their own row
-- (needed for nothing today, in practice — the columns that actually
-- change on self-service, display_name/avatar_url/last_login_at, are
-- only ever written by the security-definer trigger below, which
-- bypasses RLS entirely) but the `with check` here is what stops a
-- student from ever WIDENING their own access via a raw REST PATCH to
-- their own row. It already pinned status/allow_all_tests; access_*
-- must be pinned the exact same way now that they exist, or adding
-- these two columns would silently reopen exactly the hole this policy
-- was written to close.
-- ---------------------------------------------------------------------
drop policy if exists users_update_self_profile on public.users;
create policy users_update_self_profile on public.users
  for update using (id = auth.uid())
  with check (
    id = auth.uid()
    and status = (select status from public.users where id = auth.uid())
    and allow_all_tests = (select allow_all_tests from public.users where id = auth.uid())
    and access_started_at is not distinct from (select access_started_at from public.users where id = auth.uid())
    and access_expires_at is not distinct from (select access_expires_at from public.users where id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- Propagate an invite's intended access window to the real users row —
-- ONLY at first insert, never on a later conflict/re-login. Mirrors
-- 0007's own handling of `status` exactly (see that file's comment:
-- "status is deliberately NEVER touched here, insert or conflict") and
-- for the identical reason: an invited_students row is never deleted
-- once matched (admin/js/users.js just hides it from the list client-
-- side), so re-copying on every login would silently overwrite any
-- later "Extend Access"/"Change Expiration" the admin did directly on
-- the real row.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_invited boolean;
  v_invite_expires timestamptz;
begin
  select access_expires_at, true
    into v_invite_expires, v_is_invited
    from public.invited_students where email = lower(new.email);

  insert into public.users (id, email, email_verified, display_name, avatar_url, status, access_started_at, access_expires_at)
  values (
    new.id,
    new.email,
    coalesce(new.email_confirmed_at is not null, false),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url',
    case when v_is_invited then 'active' else 'pending' end,
    case when v_is_invited then now() else null end,
    case when v_is_invited then v_invite_expires else null end
  )
  on conflict (id) do update set
    email = excluded.email,
    email_verified = excluded.email_verified,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    last_login_at = now()
    -- status/access_started_at/access_expires_at: never touched here,
    -- insert or conflict, same as before this migration.
  ;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Audit log (spec §25). Admin-read-only; nobody gets a direct INSERT
-- grant at all — every row is written by a SECURITY DEFINER RPC below,
-- which bypasses RLS as the function owner. This means the log can't be
-- forged or tampered with by writing directly to the table even from an
-- authenticated admin session — only by going through one of the real
-- access-management actions this migration adds.
-- ---------------------------------------------------------------------
create table public.access_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.users(id),
  action text not null,
  target_user_id uuid references public.users(id) on delete set null,
  target_email text not null,
  old_expires_at timestamptz,
  new_expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index access_audit_log_target_idx on public.access_audit_log(target_user_id);

alter table public.access_audit_log enable row level security;
create policy access_audit_log_admin_read on public.access_audit_log
  for select using (public.is_admin(auth.uid()));
grant select on public.access_audit_log to authenticated;

-- ---------------------------------------------------------------------
-- Admin RPCs — all SECURITY DEFINER (so they can write users/
-- invited_students/access_audit_log regardless of the calling admin's
-- own RLS reach) but EVERY one independently re-checks is_admin(auth.uid())
-- as its very first act and raises if not, exactly like get_exam_content()
-- already does — the EXECUTE grant to `authenticated` below is not
-- treated as the real gate, it's defense in depth on top of it.
--
-- Bulk actions are NOT separate RPCs: admin/js/users.js calls the
-- single-row RPC once per selected student (Promise.allSettled), which
-- is what lets a bulk action report real partial failure ("16 updated,
-- 2 failed") per spec §26, rather than an all-or-nothing transaction
-- that can only report total success or total failure.
--
-- All time math uses now() — the DATABASE's clock, never a
-- client-supplied timestamp for the "extend by N days" case (spec §31).
-- The one exception, by design: `p_custom_expires_at`/`p_expires_at`
-- for "custom duration" / "change expiration" is necessarily an exact
-- moment the ADMIN chose and must be stored verbatim — that is not the
-- same thing as trusting a client's idea of "what time is it now".
-- ---------------------------------------------------------------------

create or replace function public.admin_add_student(p_email text, p_days int default null, p_custom_expires_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_expires timestamptz := coalesce(p_custom_expires_at, case when p_days is not null then now() + (p_days || ' days')::interval else null end);
  v_existing_id uuid;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select id into v_existing_id from public.users where email = v_email;

  if v_existing_id is not null then
    update public.users set access_started_at = now(), access_expires_at = v_expires where id = v_existing_id;
  else
    insert into public.invited_students (email, access_expires_at, created_by)
    values (v_email, v_expires, auth.uid())
    on conflict (email) do update set access_expires_at = excluded.access_expires_at;
  end if;

  insert into public.access_audit_log (admin_id, action, target_user_id, target_email, new_expires_at)
  values (auth.uid(), 'ACCESS_GRANTED', v_existing_id, v_email, v_expires);
end;
$$;

create or replace function public.admin_extend_access(p_user_id uuid, p_days int default null, p_custom_expires_at timestamptz default null)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old timestamptz;
  v_base timestamptz;
  v_new timestamptz;
  v_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select access_expires_at, email into v_old, v_email from public.users where id = p_user_id;
  if v_email is null then
    raise exception 'Student not found';
  end if;

  if p_custom_expires_at is not null then
    v_new := p_custom_expires_at;
  else
    -- new_expiration = max(current_expiration, current_time) + extension — spec's own exact formula.
    -- A null current expiration (unlimited) is treated as "already infinitely in the future": extending
    -- an unlimited account moves it to a finite, sooner expiration starting from that extension, which
    -- is the only reading that makes "extend" mean something for that account at all.
    v_base := greatest(coalesce(v_old, now()), now());
    v_new := v_base + (p_days || ' days')::interval;
  end if;

  update public.users set access_expires_at = v_new, access_started_at = coalesce(access_started_at, now()) where id = p_user_id;

  insert into public.access_audit_log (admin_id, action, target_user_id, target_email, old_expires_at, new_expires_at)
  values (auth.uid(), 'ACCESS_EXTENDED', p_user_id, v_email, v_old, v_new);

  return v_new;
end;
$$;

create or replace function public.admin_set_expiration(p_user_id uuid, p_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old timestamptz;
  v_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select access_expires_at, email into v_old, v_email from public.users where id = p_user_id;
  if v_email is null then
    raise exception 'Student not found';
  end if;

  update public.users set access_expires_at = p_expires_at, access_started_at = coalesce(access_started_at, now()) where id = p_user_id;

  insert into public.access_audit_log (admin_id, action, target_user_id, target_email, old_expires_at, new_expires_at)
  values (auth.uid(), 'EXPIRATION_CHANGED', p_user_id, v_email, v_old, p_expires_at);
end;
$$;

create or replace function public.admin_set_status(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;
  if p_status not in ('active', 'disabled') then
    raise exception 'Invalid status';
  end if;

  select email into v_email from public.users where id = p_user_id;
  if v_email is null then
    raise exception 'Student not found';
  end if;

  update public.users set status = p_status where id = p_user_id;

  insert into public.access_audit_log (admin_id, action, target_user_id, target_email)
  values (auth.uid(), case when p_status = 'active' then 'ACCESS_ENABLED' else 'ACCESS_DISABLED' end, p_user_id, v_email);
end;
$$;

-- "Remove Access" (spec §14) — deliberately NOT a delete, and
-- deliberately distinct from Disable: status is left untouched, only
-- access_expires_at is set to right now. The student keeps their full
-- history/row and shows as EXPIRED going forward (not DISABLED),
-- matching "clearly distinguish Disable / Expired / Remove Access from
-- permanent account deletion" — this project's admin panel has no
-- account-deletion feature at all today, so there was nothing existing
-- to check/preserve there.
create or replace function public.admin_remove_access(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old timestamptz;
  v_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select access_expires_at, email into v_old, v_email from public.users where id = p_user_id;
  if v_email is null then
    raise exception 'Student not found';
  end if;

  update public.users set access_expires_at = now() where id = p_user_id;

  insert into public.access_audit_log (admin_id, action, target_user_id, target_email, old_expires_at, new_expires_at)
  values (auth.uid(), 'ACCESS_REMOVED', p_user_id, v_email, v_old, now());
end;
$$;

revoke all on function public.admin_add_student(text, int, timestamptz) from public;
revoke all on function public.admin_extend_access(uuid, int, timestamptz) from public;
revoke all on function public.admin_set_expiration(uuid, timestamptz) from public;
revoke all on function public.admin_set_status(uuid, text) from public;
revoke all on function public.admin_remove_access(uuid) from public;
grant execute on function public.admin_add_student(text, int, timestamptz) to authenticated;
grant execute on function public.admin_extend_access(uuid, int, timestamptz) to authenticated;
grant execute on function public.admin_set_expiration(uuid, timestamptz) to authenticated;
grant execute on function public.admin_set_status(uuid, text) to authenticated;
grant execute on function public.admin_remove_access(uuid) to authenticated;

-- Nothing else changes: is_admin()/has_test_access()/get_exam_content()/
-- publish_test()/the scoring-protection trigger/admin-revoke-session are
-- all untouched by this migration.
