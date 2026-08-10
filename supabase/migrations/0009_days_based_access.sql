-- NMT CBT — Days-based access workflow (refines 0008, doesn't replace it).
--
-- INSPECTED FIRST (per this session's own §1/§36): 0008_access_expiration.sql
-- is already deployed, so it is NOT edited here — every change below is
-- either a `create or replace function` with the EXACT SAME signature as
-- before (safe: same name+argtypes = a real replace, not a new overload)
-- or a genuinely new function. No new columns, no new concept of
-- "expiration_days" — access_expires_at/access_started_at remain the only
-- stored source of truth; days are still only ever an RPC INPUT, converted
-- to a real timestamp by the database's own now(), never by the client.

-- ---------------------------------------------------------------------
-- Shared day-count validation, used by every RPC below that accepts a
-- p_days argument — one authoritative rule instead of duplicating the
-- same two conditions in four separate function bodies.
-- ---------------------------------------------------------------------
create or replace function public.validate_access_days(p_days int)
returns void
language plpgsql
as $$
begin
  if p_days is not null and (p_days <= 0 or p_days > 3650) then
    raise exception 'Please enter a valid number of days (1–3650).';
  end if;
end;
$$;

-- admin_add_student — same signature/behavior as 0008, now validates p_days.
create or replace function public.admin_add_student(p_email text, p_days int default null, p_custom_expires_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_expires timestamptz;
  v_existing_id uuid;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;
  perform public.validate_access_days(p_days);

  v_expires := coalesce(p_custom_expires_at, case when p_days is not null then now() + (p_days || ' days')::interval else null end);

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

-- admin_extend_access — same signature/behavior as 0008, now validates p_days.
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
  perform public.validate_access_days(p_days);

  select access_expires_at, email into v_old, v_email from public.users where id = p_user_id;
  if v_email is null then
    raise exception 'Student not found';
  end if;

  if p_custom_expires_at is not null then
    v_new := p_custom_expires_at;
  else
    v_base := greatest(coalesce(v_old, now()), now());
    v_new := v_base + (p_days || ' days')::interval;
  end if;

  update public.users set access_expires_at = v_new, access_started_at = coalesce(access_started_at, now()) where id = p_user_id;

  insert into public.access_audit_log (admin_id, action, target_user_id, target_email, old_expires_at, new_expires_at)
  values (auth.uid(), 'ACCESS_EXTENDED', p_user_id, v_email, v_old, v_new);

  return v_new;
end;
$$;

-- admin_set_expiration — SIGNATURE CHANGE from 0008 (was p_user_id, p_expires_at
-- only). Dropped and recreated rather than `create or replace` with a new
-- trailing param, because Postgres identifies a function by (name, argtypes)
-- — `create or replace` with a different argument list creates a SECOND,
-- overloaded function rather than replacing the first, which risks the
-- client's named-parameter RPC call resolving ambiguously between the two.
-- Dropping first guarantees exactly one function named admin_set_expiration
-- exists, matching admin_add_student/admin_extend_access's own established
-- "multiple optional named params on one function" shape exactly.
--
-- "Remove expiration" is simply calling this with neither argument — both
-- default to null, v_new resolves to null, which already means unlimited
-- everywhere else in this schema (is_active_user, computeAccess on the
-- frontend). No separate "remove" RPC needed.
drop function if exists public.admin_set_expiration(uuid, timestamptz);

create function public.admin_set_expiration(p_user_id uuid, p_expires_at timestamptz default null, p_days int default null)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old timestamptz;
  v_new timestamptz;
  v_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;
  perform public.validate_access_days(p_days);

  select access_expires_at, email into v_old, v_email from public.users where id = p_user_id;
  if v_email is null then
    raise exception 'Student not found';
  end if;

  v_new := coalesce(p_expires_at, case when p_days is not null then now() + (p_days || ' days')::interval else null end);

  update public.users set access_expires_at = v_new, access_started_at = coalesce(access_started_at, now()) where id = p_user_id;

  insert into public.access_audit_log (admin_id, action, target_user_id, target_email, old_expires_at, new_expires_at)
  values (auth.uid(), 'EXPIRATION_CHANGED', p_user_id, v_email, v_old, v_new);

  return v_new;
end;
$$;

revoke all on function public.admin_set_expiration(uuid, timestamptz, int) from public;
grant execute on function public.admin_set_expiration(uuid, timestamptz, int) to authenticated;

-- ---------------------------------------------------------------------
-- admin_extend_access_bulk — one round trip instead of N (spec §21/§22).
-- Still one audit_log row PER student (never a single collapsed bulk
-- entry — the spec's own §35 explicitly wants a real per-student
-- record: admin_id/target_user_id/target_email/old/new expiration each).
-- Loops server-side in a single PL/pgSQL FOREACH so a failure on one
-- user_id (e.g. a stale/deleted id) never aborts the whole batch — each
-- row is caught individually and reported back, which is what makes
-- "22 updated, 2 failed" possible from a single RPC call. Returns a
-- result set the client renders directly; nothing here decides UI text.
-- ---------------------------------------------------------------------
create or replace function public.admin_extend_access_bulk(p_user_ids uuid[], p_days int)
returns table (user_id uuid, email text, new_expires_at timestamptz, success boolean, error_message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_old timestamptz;
  v_base timestamptz;
  v_new timestamptz;
  v_email text;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;
  perform public.validate_access_days(p_days);

  foreach v_id in array coalesce(p_user_ids, array[]::uuid[])
  loop
    v_email := null;
    begin
      select u.access_expires_at, u.email into v_old, v_email from public.users u where u.id = v_id;
      if v_email is null then
        user_id := v_id; email := null; new_expires_at := null; success := false; error_message := 'Student not found';
        return next;
        continue;
      end if;

      v_base := greatest(coalesce(v_old, now()), now());
      v_new := v_base + (p_days || ' days')::interval;

      update public.users set access_expires_at = v_new, access_started_at = coalesce(access_started_at, now()) where id = v_id;

      insert into public.access_audit_log (admin_id, action, target_user_id, target_email, old_expires_at, new_expires_at)
      values (auth.uid(), 'ACCESS_EXTENDED', v_id, v_email, v_old, v_new);

      user_id := v_id; email := v_email; new_expires_at := v_new; success := true; error_message := null;
      return next;
    exception when others then
      user_id := v_id; email := v_email; new_expires_at := null; success := false; error_message := sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

revoke all on function public.admin_extend_access_bulk(uuid[], int) from public;
grant execute on function public.admin_extend_access_bulk(uuid[], int) to authenticated;

-- Nothing else changes: users/invited_students schema, is_active_user(),
-- has_test_access(), get_exam_content(), the self-update RLS hardening,
-- admin_set_status()/admin_remove_access()/admin_add_student()'s core
-- shape, and access_audit_log's own schema/RLS are all untouched.
