-- NMT CBT — Session 16: close the "browser-submitted score" hole.
--
-- Before this migration, an authenticated student could open devtools
-- and run:
--   supabase.from('test_attempts').update({ score: 250, result: {...} }).eq('id', myAttemptId)
-- and RLS would allow it — attempts_update_own only checked *ownership*
-- of the row, never *who computed the score*. This migration adds a
-- trigger that silently pins status/score/max_score/result/submitted_at
-- back to their previous values for any UPDATE that isn't performed by
-- the service_role (i.e. anything that isn't the submit-attempt Edge
-- Function — see supabase/functions/submit-attempt/index.ts, which is
-- now the only real path to a 'submitted' attempt).
--
-- This does NOT and cannot prevent someone from reading a test's
-- correctOption values ahead of time (they're shipped to the client for
-- the exam UI's own instant "Review Answers" screen) — seeing this
-- migration's header comment for that pre-existing, disclosed, separate
-- limitation. What it does prevent is fabricating a fake submitted
-- score/result on your own attempt row after the fact.

create or replace function public.protect_attempt_scoring()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The submit-attempt Edge Function connects using the service-role
  -- key, whose JWT carries role = 'service_role'. That's the only
  -- caller allowed to actually set these fields — on INSERT or UPDATE.
  if auth.role() = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A client-side insert (the only kind that isn't the Edge Function)
    -- always starts an attempt as freshly in_progress with no score yet,
    -- regardless of what values were sent — otherwise someone could
    -- skip the UPDATE guard entirely by fabricating a 'submitted' row
    -- straight from INSERT.
    new.status := 'in_progress';
    new.score := null;
    new.max_score := null;
    new.result := null;
    new.submitted_at := null;
    return new;
  end if;

  -- UPDATE from anyone else (including admins updating their own row)
  -- gets these five columns silently pinned back to their previous
  -- values. Deliberately silent rather than an error, so an ordinary
  -- client update that never touches these fields in the first place
  -- (e.g. a future "save partial progress" feature patching other
  -- columns) isn't broken by this guard.
  new.status := old.status;
  new.score := old.score;
  new.max_score := old.max_score;
  new.result := old.result;
  new.submitted_at := old.submitted_at;
  return new;
end;
$$;

drop trigger if exists protect_attempt_scoring_trigger on public.test_attempts;
create trigger protect_attempt_scoring_trigger
  before insert or update on public.test_attempts
  for each row execute function public.protect_attempt_scoring();

-- Both INSERT and UPDATE are now guarded — a client can create an
-- in_progress attempt (as startOrResumeAttempt() already does) and
-- nothing else; only the service-role-authenticated Edge Function can
-- ever move a row to 'submitted' with a real score attached.
