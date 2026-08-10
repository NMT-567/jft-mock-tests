-- NMT CBT — Default new students to "Allow All Tests" (spec's own Option C).
--
-- INSPECTED FIRST (per this session's own §A): the root cause is exactly
-- one thing. public.users.allow_all_tests defaults to `false`
-- (0001_init.sql). The trigger that actually creates a student's real
-- row on first sign-in, handle_new_auth_user() (redefined in 0007 and
-- again in 0008 — unchanged by this migration), never lists
-- allow_all_tests in its INSERT column list at all, so every new
-- student's row always falls through to whatever the table's default
-- currently is. admin_add_student() (0008/0009, also unchanged here)
-- never touches this column for either of its two paths — inserting an
-- invite (invited_students has no such column) or updating an already-
-- existing real user (its UPDATE statement doesn't mention
-- allow_all_tests at all, which is exactly why re-adding an existing
-- student already correctly preserves whatever value they have).
--
-- So the ONE correct fix is the table default itself — exactly the
-- "safest design" this session's own spec asked for, and it requires
-- zero RPC signature changes (nothing to overload, nothing to drop).
--
-- SAFETY: `alter column ... set default` only changes what a FUTURE
-- insert falls back to when it omits the column. It is a metadata-only
-- change — it does not read, write, or lock existing rows, and cannot
-- alter any existing student's stored allow_all_tests value. No
-- existing student is touched by this migration, by construction, not
-- just by intent — there is no UPDATE statement anywhere in this file.

alter table public.users
  alter column allow_all_tests set default true;

-- Nothing else changes: no RPC signatures, no RLS policies, no other
-- column defaults, no existing migration files, no existing rows.
