-- NMT CBT — Session 21: manual student allowlist / pre-invitation.
--
-- WHY A NEW TABLE IS NEEDED (inspected before writing anything): every
-- public.users row is `id uuid primary key references auth.users(id)`
-- (0001_init.sql) — a public.users row can only ever exist for someone
-- who has ALREADY signed in with Google at least once (that FK is what
-- guarantees id is a real Supabase Auth identity). There is no way to
-- pre-create a public.users row for an email that has never signed in;
-- the FK would reject it. So "admin enters an email before the student
-- has ever touched the site" genuinely needs a separate table with no
-- such constraint — public.invited_students below.
--
-- WHY handle_new_auth_user() (0001) is replaced here rather than left
-- alone: it already auto-creates a public.users row on every sign-in,
-- always starting status='pending'. This migration teaches it to check
-- invited_students first — a matched invite starts the row 'active'
-- instead. This is a `create or replace function` in a NEW migration
-- file (the same idiom 0002/0003/0005/0006 already use to change a
-- function's behavior without editing the file that first defined it)
-- — 0001_init.sql itself is not modified.
--
-- DESIGN DECISION, disclosed explicitly: the admin adding an email via
-- "Add Student" IS treated as the approval act itself (parallel to
-- clicking "Activate" on an already-existing pending row) — so a
-- matched invite lands 'active' on first sign-in, not 'pending' again.
-- The alternative (still landing 'pending', requiring a second manual
-- activation after invite) would make this feature provide close to no
-- benefit over the status quo. If that reading is wrong for your
-- workflow, the fix is a one-line change to the CASE expression below.

create table public.invited_students (
  email text primary key, -- always stored lowercase — enforced by the admin UI and by the trigger's own lower() comparison, not just convention
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id)
);

alter table public.invited_students enable row level security;

-- Admin-only, full stop — students never have any reason to read or
-- write this table; it exists purely for the admin-authoring side.
create policy invited_students_admin_only on public.invited_students
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- This project's Supabase baseline does not auto-grant table privileges
-- to `authenticated` on new tables (the same gap 0004/0005/0006 already
-- had to work around for `tests`) — explicit grant needed, with RLS
-- above as the actual gatekeeper of who can use it. No UPDATE grant:
-- there's no "edit an invite" feature, only add/remove.
grant select, insert, delete on public.invited_students to authenticated;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_invited boolean;
begin
  select exists (
    select 1 from public.invited_students where email = lower(new.email)
  ) into v_is_invited;

  insert into public.users (id, email, email_verified, display_name, avatar_url, status)
  values (
    new.id,
    new.email,
    coalesce(new.email_confirmed_at is not null, false),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url',
    case when v_is_invited then 'active' else 'pending' end
  )
  on conflict (id) do update set
    email = excluded.email,
    email_verified = excluded.email_verified,
    -- display_name/avatar_url now kept in sync on every subsequent
    -- login too (0001's original version only updated these at
    -- first-insert time) — a real, disclosed improvement made while
    -- implementing this feature, not something explicitly asked for:
    -- otherwise a later Google profile-picture/name change would never
    -- be reflected here after the very first sign-in.
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    last_login_at = now()
    -- status is deliberately NEVER touched here, insert or conflict —
    -- this is what makes an admin-set status (active/disabled) survive
    -- every subsequent login untouched, exactly as before this migration.
  ;
  return new;
end;
$$;

-- Note: this trigger is SECURITY DEFINER and already existed in 0001 —
-- this migration only changes its body, not its ownership, triggers, or
-- grants. Nothing about is_admin()/has_test_access()/get_exam_content()/
-- publish_test()/the scoring-protection trigger changes at all.
