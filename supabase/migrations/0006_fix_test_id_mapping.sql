-- NMT CBT — Session 20: fix the local-draft-id vs. tests.id UUID mismatch.
--
-- ROOT CAUSE (reproduced against a real local Postgres instance running
-- 0001-0005 unmodified): admin/js/storage.js's generateId("test") — used
-- for every local editor draft since long before Supabase existed —
-- produces ids like `test-mskidqg4-wvi7tt`. publish.js and
-- publish_test() (0005) assumed draft.id could double as tests.id
-- directly, but tests.id is `uuid` (0001) with no implicit text-to-uuid
-- cast for arbitrary strings, so this failed the moment a real draft
-- (rather than a synthetic UUID-shaped test id) was published:
--   invalid input syntax for type uuid: "test-mskidqg4-wvi7tt"
-- This was never caught earlier because every previous verification of
-- publish_test() used literal UUID-shaped test ids, not a realistic
-- generateId() output — a real gap in that testing, not just a code bug.
--
-- FIX: tests.id remains a real, Supabase-generated UUID (unchanged —
-- test_access.test_id and test_attempts.test_id keep referencing it
-- exactly as before, and every student-facing path — the dashboard,
-- get_exam_content(), attempts — already only ever uses this UUID, never
-- the local draft id, so none of that needs to change). A new
-- `local_draft_id` column is the stable mapping key admins publish by;
-- publish_test() now looks up/inserts/updates by THIS column via
-- `on conflict (local_draft_id)`, and Postgres itself generates the
-- actual `id` UUID on first insert (via the existing `default
-- gen_random_uuid()` from 0001 — untouched).

-- Existing rows (if any) from testing 0005 have no local_draft_id and
-- keep working fine — this column is only consulted going forward for
-- NEW publishes; nothing about existing rows' real `id` UUIDs changes.
alter table public.tests add column if not exists local_draft_id text unique;

comment on column public.tests.local_draft_id is
  'The local admin editor draft''s own id (see admin/js/storage.js''s generateId("test")) — NOT a UUID, purely a stable republish key so publish_test() can find "this same draft" across multiple publishes. Never referenced by test_access/test_attempts or anything student-facing; those only ever use the real tests.id UUID.';

-- 0003_hide_answer_key.sql revoked table-level SELECT on `tests` and
-- re-granted it only for a specific column list — a column added
-- AFTER that migration ran does NOT automatically inherit that grant
-- (each column-level grant is its own explicit privilege, not a "any
-- future column" default). Without this, any query filtering or
-- selecting on local_draft_id fails with the same permission-denied
-- error, even though this column holds nothing sensitive (it's an
-- admin-authoring-side draft id string, not part of the answer key).
grant select (local_draft_id) on public.tests to authenticated, anon;

-- Replace publish_test() with a version keyed on local_draft_id instead
-- of accepting a caller-supplied id at all — tests.id is now always
-- database-generated, never supplied by the client. The old
-- uuid-typed-first-argument version from 0005 is a DIFFERENT function
-- signature in Postgres terms (functions are identified by name + arg
-- types), so it's explicitly dropped here rather than left dangling
-- alongside the new one.
drop function if exists public.publish_test(uuid, text, text, text, jsonb, int, int);

create or replace function public.publish_test(
  p_local_draft_id text,
  p_title text,
  p_category_name text,
  p_status text,
  p_content jsonb,
  p_total_questions int,
  p_total_points int
)
returns jsonb -- deliberately returns only safe metadata, never content — unchanged from 0005
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin role required';
  end if;
  if p_status not in ('draft', 'published', 'archived') then
    raise exception 'invalid status: %', p_status;
  end if;
  if p_local_draft_id is null or length(trim(p_local_draft_id)) = 0 then
    raise exception 'local_draft_id is required';
  end if;

  insert into public.tests (
    local_draft_id, title, category_name, status, content,
    total_questions, total_points, created_by, updated_at, published_at
  )
  values (
    p_local_draft_id, p_title, p_category_name, p_status, p_content,
    p_total_questions, p_total_points, auth.uid(), now(),
    case when p_status = 'published' then now() else null end
  )
  on conflict (local_draft_id) do update set
    title = excluded.title,
    category_name = excluded.category_name,
    status = excluded.status,
    content = excluded.content,
    total_questions = excluded.total_questions,
    total_points = excluded.total_points,
    updated_at = excluded.updated_at,
    published_at = case
      when excluded.status = 'published' and public.tests.published_at is null then now()
      else public.tests.published_at
    end
  returning jsonb_build_object(
    'id', id, 'local_draft_id', local_draft_id, 'title', title, 'status', status,
    'total_questions', total_questions, 'total_points', total_points,
    'updated_at', updated_at, 'published_at', published_at
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.publish_test(text, text, text, text, jsonb, int, int) from public;
grant execute on function public.publish_test(text, text, text, text, jsonb, int, int) to authenticated;

-- Nothing else changes: is_admin()/has_test_access()/get_exam_content()
-- (0001/0003), the scoring-protection trigger (0002), and 0004's grants
-- are all untouched by this migration — none of them ever referenced
-- tests.id in a way that assumed it came from the client.
