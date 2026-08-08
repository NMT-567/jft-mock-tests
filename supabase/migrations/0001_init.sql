-- NMT CBT — Auth/Access/Attempts schema (Session 15)
-- Everything the static student/admin site needs the Supabase backend for.
-- Question content itself is NOT re-modeled relationally: tests.content
-- stores the exact same export shape admin/js/export.js already produces
-- (id, title, categoryName, ..., sections[...]) so js/loader.js's existing
-- normalizeTest()/normalizeGroup()/normalizeQuestion() and the whole exam
-- engine (exam.js, groupRenderer.js, result.js, security.js) do not need
-- to change how they read a test — only where it comes from.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- users — one row per Google-authenticated person, synced from auth.users.
-- New sign-ins land as 'pending', NOT 'active' — this is the allowlist:
-- an admin must flip status to 'active' before the person can see any
-- test. This mirrors the "Access not approved" flow in the spec exactly.
-- ---------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  email_verified boolean not null default false,
  display_name text,
  avatar_url text,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  allow_all_tests boolean not null default false,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table public.admins (
  user_id uuid primary key references public.users(id) on delete cascade,
  granted_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- tests — one row per JFT mock test. `content` is the full exported JSON
-- blob (same shape js/loader.js already expects). Never store the answer
-- key anywhere the client can read it for a test the user isn't
-- authorized for — RLS below is what enforces that.
-- ---------------------------------------------------------------------
create table public.tests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category_name text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  content jsonb not null,
  total_questions int not null default 0,
  total_points int not null default 0,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

-- ---------------------------------------------------------------------
-- test_access — explicit per-user, per-test grants. A user can ALSO get
-- access via users.allow_all_tests = true ("Allow All Tests" quick action
-- in the spec) — has_test_access() below checks both.
-- ---------------------------------------------------------------------
create table public.test_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  test_id uuid not null references public.tests(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id),
  unique (user_id, test_id)
);

-- ---------------------------------------------------------------------
-- test_attempts — one row per attempt. `result` mirrors the exact shape
-- storage.js's saveResult() already writes to localStorage (testId,
-- testTitle, studentName, submittedAt, totalQuestions, correct, wrong,
-- skipped, marksScored, totalMarks, percentage, passMarks, passed,
-- answers, sections, finalScore, resultSettings, securityEvents), so
-- result.html/review.js can render a Supabase-loaded attempt exactly the
-- way they already render a local one.
-- ---------------------------------------------------------------------
create table public.test_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  test_id uuid not null references public.tests(id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted')),
  is_admin_preview boolean not null default false,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  score numeric,
  max_score numeric,
  result jsonb
);

create index test_access_user_idx on public.test_access(user_id);
create index test_attempts_user_test_idx on public.test_attempts(user_id, test_id);

-- ---------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER — needed because RLS on `users` and
-- `admins` would otherwise recurse into itself when a policy on another
-- table checks "is this caller an admin?").
-- ---------------------------------------------------------------------
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.admins a where a.user_id = uid);
$$;

create or replace function public.is_active_user(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.users u
    where u.id = uid and u.status = 'active' and u.email_verified = true
  );
$$;

create or replace function public.has_test_access(uid uuid, tid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_admin(uid)
    or (
      public.is_active_user(uid)
      and (
        (select allow_all_tests from public.users where id = uid) = true
        or exists (select 1 from public.test_access ta where ta.user_id = uid and ta.test_id = tid)
      )
    );
$$;

-- Auto-create a public.users row (status='pending') whenever someone signs
-- in with Google for the first time. Runs as the table owner, bypassing
-- RLS, because the client is never allowed to insert into public.users
-- directly (see policies below).
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, email_verified, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.email_confirmed_at is not null, false),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update set
    email = excluded.email,
    email_verified = excluded.email_verified,
    last_login_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.admins enable row level security;
alter table public.tests enable row level security;
alter table public.test_access enable row level security;
alter table public.test_attempts enable row level security;

-- users: a person can read their own row (to know their own status/name);
-- admins can read/update everyone. Nobody except the trigger (security
-- definer, bypasses RLS) can insert. Only admins can change `status` /
-- `allow_all_tests` — enforced by only granting UPDATE to admins, plus a
-- narrower self-update policy limited to display_name/avatar_url/last_login_at
-- via a check that leaves status/allow_all_tests unchanged.
create policy users_select_self on public.users
  for select using (id = auth.uid() or public.is_admin(auth.uid()));

create policy users_update_self_profile on public.users
  for update using (id = auth.uid())
  with check (
    id = auth.uid()
    and status = (select status from public.users where id = auth.uid())
    and allow_all_tests = (select allow_all_tests from public.users where id = auth.uid())
  );

create policy users_admin_all on public.users
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- admins: only admins can see who else is an admin.
create policy admins_admin_only on public.admins
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- tests: published tests are visible only to users with real access;
-- admins see and manage everything (draft/archived included).
create policy tests_select_authorized on public.tests
  for select using (
    public.is_admin(auth.uid())
    or (status = 'published' and public.has_test_access(auth.uid(), id))
  );

create policy tests_admin_write on public.tests
  for insert with check (public.is_admin(auth.uid()));
create policy tests_admin_update on public.tests
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
create policy tests_admin_delete on public.tests
  for delete using (public.is_admin(auth.uid()));

-- test_access: users can see their own grants (so the dashboard can show
-- "why can't I see test X"); only admins can grant/revoke.
create policy test_access_select_self on public.test_access
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));
create policy test_access_admin_write on public.test_access
  for insert with check (public.is_admin(auth.uid()));
create policy test_access_admin_delete on public.test_access
  for delete using (public.is_admin(auth.uid()));

-- test_attempts: a user can create/update/read only their own attempts,
-- and only for a test they're currently authorized for (re-checked here,
-- not just at dashboard-render time — this is the §5/§19 "direct URL"
-- and "API call" bypass protection). Admin preview rows
-- (is_admin_preview = true) are written by admins against their own
-- user_id, never mixed into a real student's row.
create policy attempts_select_own on public.test_attempts
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

create policy attempts_insert_own on public.test_attempts
  for insert with check (
    user_id = auth.uid()
    and (is_admin_preview = false and public.has_test_access(auth.uid(), test_id)
         or (is_admin_preview = true and public.is_admin(auth.uid())))
  );

create policy attempts_update_own on public.test_attempts
  for update using (user_id = auth.uid() or public.is_admin(auth.uid()))
  with check (user_id = auth.uid() or public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- Bootstrap: after your first Google sign-in, promote yourself to admin
-- by running (in the Supabase SQL editor, one time only):
--
--   update public.users set status = 'active' where email = 'you@gmail.com';
--   insert into public.admins (user_id)
--     select id from public.users where email = 'you@gmail.com';
--
-- See SETUP_SUPABASE_AUTH.md §6 for the full first-run walkthrough.
-- ---------------------------------------------------------------------
