-- NMT CBT — Session 19: fix "permission denied for table tests" on
-- publish, WITHOUT weakening 0003's answer-key protection.
--
-- ROOT CAUSE (reproduced against a real local Postgres instance running
-- 0001/0002/0003 unmodified, not guessed): admin/js/publish.js's
-- supabase-js `.upsert(row, {onConflict:"id"})` call, where `row`
-- includes `content`, generates SQL of the shape:
--
--   insert into tests (..., content, ...) values (..., $1, ...)
--   on conflict (id) do update set ..., content = excluded.content, ...
--
-- Referencing `excluded.content` requires SELECT privilege on the
-- `content` column — Postgres treats reading a column via the
-- `excluded` pseudo-row the same as reading it from the base table for
-- permission-checking purposes. `authenticated` never has that SELECT
-- privilege (0003 deliberately revoked it), so this specific SQL shape
-- fails regardless of INSERT/UPDATE privileges being present, and
-- regardless of what the RETURNING/.select() clause asks for — neither
-- of which is the real problem here.
--
-- The wrong fix would be granting `authenticated` SELECT on `content` —
-- that undoes 0003 for every student, not just admins (column grants
-- are per-ROLE; there's no way to make a GRANT conditional on
-- is_admin()). The right fix mirrors what 0003 already did for READS
-- (get_exam_content()): a SECURITY DEFINER function for the WRITE side.
-- It runs with the function owner's privileges (full table access,
-- including content), so the excluded.content reference inside it never
-- hits the caller's restricted grant — is_admin() is checked explicitly
-- inside instead of relying on the column-grant system at all.

create or replace function public.publish_test(
  p_id uuid,
  p_title text,
  p_category_name text,
  p_status text,
  p_content jsonb,
  p_total_questions int,
  p_total_points int
)
returns jsonb -- deliberately returns only safe metadata, never content
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

  insert into public.tests (
    id, title, category_name, status, content,
    total_questions, total_points, created_by, updated_at, published_at
  )
  values (
    p_id, p_title, p_category_name, p_status, p_content,
    p_total_questions, p_total_points, auth.uid(), now(),
    case when p_status = 'published' then now() else null end
  )
  on conflict (id) do update set
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
    'id', id, 'title', title, 'status', status,
    'total_questions', total_questions, 'total_points', total_points,
    'updated_at', updated_at, 'published_at', published_at
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.publish_test(uuid, text, text, text, jsonb, int, int) from public;
grant execute on function public.publish_test(uuid, text, text, text, jsonb, int, int) to authenticated;

-- Note: setTestStatus() and deleteSupabaseTest() in admin/js/publish.js
-- are NOT affected by this bug and are NOT changed — neither one's SQL
-- ever references `excluded.content` (setTestStatus is a plain UPDATE
-- touching only status/updated_at; delete touches no columns at all).
-- Verified by the same local reproduction, not assumed.
