-- NMT CBT — Session 17: the answer key must never reach the browser
-- before submission.
--
-- Before this migration, js/loader.js fetched a test via
-- `supabase.from('tests').select('content')` — RLS correctly restricted
-- WHICH ROWS a student could see, but did nothing to restrict WHICH
-- COLUMNS. `content` is a single JSONB blob holding the entire test,
-- including every question's `correctOption` and `explanation` — so an
-- authorized student's normal, permitted read of a test they're allowed
-- to take ALSO handed them the full answer key, readable directly in
-- the browser's network tab or via one line in devtools. This was never
-- a bug in the row-level policy; it was a missing column-level boundary.
--
-- Fix, in two parts:
--   1. Revoke SELECT on `tests` entirely for the normal client roles,
--      then re-grant it only for the specific non-content columns the
--      dashboard/admin list views actually need. This makes `content`
--      structurally unreachable via the ordinary REST table endpoint,
--      for EVERY role — including admins, who now go through part 2
--      instead.
--   2. A SECURITY DEFINER function, get_exam_content(test_id), is the
--      only way anyone reads `content` from application code from here
--      on. It re-runs the same authorization check the old RLS policy
--      did (is_admin() OR published+has_test_access), and only then
--      decides: admins get the real content (they need to see/edit
--      answer keys — see admins_get_full_answer_key below); everyone
--      else gets a version with correctOption/explanation stripped
--      from every question via strip_answer_key().
--
-- After this migration, js/loader.js calls
-- `supabase.rpc('get_exam_content', { p_test_id: testId })` instead of
-- the old `.select('content')` — see that file's updated fetchExport().

-- ---------------------------------------------------------------------
-- 1. Column-level lockdown. No role can SELECT `content` directly
--    through the REST table endpoint after this — not students, not
--    admins. (RLS row policies from 0001_init.sql still apply on top of
--    this for whichever columns ARE grantable — this is in addition to,
--    not instead of, RLS.)
-- ---------------------------------------------------------------------
revoke select on public.tests from authenticated, anon;
grant select (
  id, title, category_name, status, total_questions, total_points,
  created_by, created_at, updated_at, published_at
) on public.tests to authenticated, anon;

-- ---------------------------------------------------------------------
-- 2. strip_answer_key(content) — pure jsonb transform, no table access,
--    so it's safe to be callable by anyone (there's nothing to protect
--    inside the function itself; the protection is in NOT calling it
--    with unstripped content for a non-admin, which get_exam_content()
--    below is responsible for).
-- ---------------------------------------------------------------------
create or replace function public.strip_answer_key(content jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  stripped_sections jsonb := '[]'::jsonb;
  sec jsonb;
  stripped_groups jsonb;
  grp jsonb;
  stripped_questions jsonb;
  q jsonb;
begin
  for sec in select * from jsonb_array_elements(coalesce(content->'sections', '[]'::jsonb))
  loop
    stripped_groups := '[]'::jsonb;
    for grp in select * from jsonb_array_elements(coalesce(sec->'groups', '[]'::jsonb))
    loop
      stripped_questions := '[]'::jsonb;
      for q in select * from jsonb_array_elements(coalesce(grp->'questions', '[]'::jsonb))
      loop
        -- Removes correctOption AND explanation — explanation text
        -- routinely restates or gives away the correct answer (e.g.
        -- "Correct: B, because..."), so it's just as much a leak as
        -- correctOption itself if shipped before submission.
        stripped_questions := stripped_questions || jsonb_build_array(q - 'correctOption' - 'explanation');
      end loop;
      stripped_groups := stripped_groups || jsonb_build_array(jsonb_set(grp, '{questions}', stripped_questions));
    end loop;
    stripped_sections := stripped_sections || jsonb_build_array(jsonb_set(sec, '{groups}', stripped_groups));
  end loop;
  return jsonb_set(content, '{sections}', stripped_sections);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. get_exam_content(test_id) — the only path to `tests.content` from
--    application code. Re-implements the exact same authorization
--    logic the old `tests_select_authorized` RLS policy had (see
--    0001_init.sql) — this function is what that policy's job moved
--    into, now that the column itself isn't reachable at all.
-- ---------------------------------------------------------------------
create or replace function public.get_exam_content(p_test_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_content jsonb;
  v_status text;
begin
  select content, status into v_content, v_status
  from public.tests where id = p_test_id;

  if v_content is null then
    return null; -- row doesn't exist — same "don't distinguish from unauthorized" behavior as before
  end if;

  -- admins_get_full_answer_key: admins need real correctOption values to
  -- edit questions, verify answer keys, and use "Preview"/"Preview as
  -- User" meaningfully (spec requirement: admin preview must still show
  -- correct answers). This is the ONE place in the whole system that
  -- branches behavior on is_admin() for content visibility.
  if public.is_admin(auth.uid()) then
    return v_content;
  end if;

  if v_status != 'published' or not public.has_test_access(auth.uid(), p_test_id) then
    return null; -- not published, or not granted — never distinguished to the caller, same as before
  end if;

  return public.strip_answer_key(v_content);
end;
$$;

revoke all on function public.get_exam_content(uuid) from public;
grant execute on function public.get_exam_content(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Note on admin/js/publish.js and admin/js/tests.js: neither ever
-- selected `content` directly (publish.js WRITES it via upsert, which
-- is a separate privilege from SELECT and is unaffected by this
-- migration; tests.js's listSupabaseTests() only ever selected
-- non-content columns). Only js/loader.js's fetchExport() needed to
-- change — see that file's updated comment.
-- ---------------------------------------------------------------------
