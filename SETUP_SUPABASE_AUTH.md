# Supabase + Google OAuth Setup

Follow this once, in order. Nothing in the app works until steps 1-6 are
done — the student site will show a Google sign-in button that fails,
and the admin panel has no way to approve anyone.

---

## 1. Create the Supabase project

1. Go to https://supabase.com/dashboard → **New project**.
2. Pick any name/region/database password (the DB password is only used
   if you connect a SQL client directly — the app never uses it).
3. Wait for provisioning (~2 min).
4. In **Project Settings → API**, copy:
   - **Project URL** (`https://xxxxx.supabase.co`)
   - **anon / public key** (a long JWT starting `eyJ...`)

   These two are safe to put in client-side code — see `js/config.js`'s
   header comment for why. Do **not** copy the `service_role` key
   anywhere in this repo; it's only ever used inside the Edge Function
   in step 7.

## 2. Run the database migrations

1. In the Supabase dashboard, open **SQL Editor**.
2. Paste and run `supabase/migrations/0001_init.sql` in full. This creates
   `users`, `admins`, `tests`, `test_access`, `test_attempts`, the RLS
   policies, and the auto-provisioning trigger.
3. Then paste and run `supabase/migrations/0002_protect_scoring.sql`.
   This one closes a real hole: without it, a signed-in student could
   open devtools and directly write a fake score to their own attempt
   row (RLS only checks ownership, not who computed the score). It adds
   a trigger that only lets the `submit-attempt` Edge Function (step 7)
   actually set `status`/`score`/`result` — everyone else's writes to
   those columns are silently ignored.
4. Then paste and run `supabase/migrations/0003_hide_answer_key.sql`.
   This one closes a second, separate hole: before it, a student's
   normal, authorized read of a test they're allowed to take ALSO
   handed them every question's `correctOption` and `explanation` —
   the full answer key — because `tests.content` was a single JSONB
   blob with no way to read "the question" without also reading "the
   answer." This migration revokes direct column access to `content`
   entirely (for every role, including admins) and adds a
   `get_exam_content()` function as the only path to it — admins get
   the real thing back, everyone else gets a version with
   `correctOption`/`explanation` stripped out server-side, before it
   ever reaches the browser.
5. Then paste and run `supabase/migrations/0004_grant_tests_write.sql`.
   This exists because this project's Supabase baseline didn't
   auto-grant `INSERT`/`UPDATE`/`DELETE` on new tables to `authenticated`
   the way a typical Supabase project's defaults do. It turned out NOT
   to be the actual cause of the publish failure some projects hit (see
   step 6) — but it's still a correct, harmless baseline to have in
   place regardless, so run it either way.
6. Then paste and run `supabase/migrations/0005_publish_function.sql`.
   This is the fix for `permission denied for table tests` on "Publish
   to Supabase," reproduced and root-caused against a real Postgres
   instance rather than guessed: a plain `upsert()` whose payload
   includes `content` generates SQL referencing `excluded.content` in
   its `ON CONFLICT` clause, which requires SELECT privilege on that
   column — a privilege `0003` deliberately withholds from every role,
   admins included, to protect the answer key. This migration adds a
   `SECURITY DEFINER` function (`publish_test()`) that writes with the
   function owner's privileges instead, checking `is_admin()` explicitly
   rather than relying on the column-grant system at all — admins can
   publish, and `0003`'s protection is completely untouched.
7. Then paste and run `supabase/migrations/0006_fix_test_id_mapping.sql`.
   Fixes a second, separate problem: local editor drafts have ids like
   `test-mskidqg4-wvi7tt` (see `admin/js/components.js`'s `generateId()`)
   — never a UUID — while `tests.id` is UUID-typed. Publishing a real
   draft (as opposed to a synthetic UUID-shaped test id) failed with
   `invalid input syntax for type uuid: "test-..."`. This migration adds
   a `local_draft_id text unique` column as the stable republish key and
   rewrites `publish_test()` to match on it — `tests.id` stays a real,
   database-generated UUID; nothing about `test_access`/`test_attempts`'
   foreign keys changes. Also fixes the same class of mistake found
   lurking in `js/exam.js` (it was passing the content-embedded draft id
   to `test_attempts.test_id`, a second place this bug would have
   surfaced the first time a real student started a real published
   exam) — see that file's updated comment for the fix.
8. Then paste and run `supabase/migrations/0007_student_allowlist.sql`.
   Adds manual student pre-invitation: `admin/users.html`'s "Add
   Student" form only needs an email — no separate table, no fake
   Google account, no password. A new `invited_students` table
   (admin-only, entirely separate from `public.users` since a
   `public.users` row can only exist for someone who has already signed
   in — see that migration's own comment) stores the pre-approved email;
   `handle_new_auth_user()` checks it on every sign-in and auto-starts a
   matching invite as `active` instead of `pending`, while everyone else
   keeps the existing unchanged behavior. Existing accounts, existing
   admin privileges, and every RLS protection (students still can't
   touch their own `status`/`allow_all_tests`) are untouched.
9. Confirm no errors. You should see 6 tables under **Table Editor**.

(If you have the Supabase CLI installed, `supabase db push` from the
repo root applies all seven migrations in order — either approach is
fine.)

## 3. Create the Google Cloud OAuth client

1. Go to https://console.cloud.google.com/ → create a project (or reuse
   one you already have).
2. **APIs & Services → OAuth consent screen**:
   - User type: **External** (unless you have a Google Workspace and
     want to restrict to your org, in which case **Internal**).
   - Fill in the app name, support email, developer contact.
   - Scopes: the defaults (`email`, `profile`, `openid`) are enough —
     don't add anything else.
   - Test users: while the app is in "Testing" mode, only accounts you
     list here can sign in. Add yourself and anyone else who needs
     access before publishing, or click **Publish App** to allow any
     Google account to attempt sign-in (they still hit the allowlist
     afterward — see step 6).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Name: anything, e.g. "NMT CBT".
   - **Authorized redirect URIs** — add exactly this one:
     ```
     https://<your-project-ref>.supabase.co/auth/v1/callback
     ```
     (Find `<your-project-ref>` in your Supabase Project URL from step 1.
     This is a Supabase-owned URL, not your GitHub Pages URL — Supabase
     is what actually exchanges the Google token, then redirects the
     browser onward to whatever `redirectTo` your app passed, which
     *does* need to be an allowed redirect in Supabase — see step 4.)
   - **Authorized JavaScript origins** — add your GitHub Pages origin,
     e.g. `https://yourusername.github.io` (no path, no trailing slash).
4. Save. Copy the **Client ID** and **Client Secret**.

## 4. Wire Google into Supabase Auth

1. In the Supabase dashboard: **Authentication → Providers → Google**.
2. Toggle it on, paste the **Client ID** and **Client Secret** from
   step 3.
3. **Authentication → URL Configuration**:
   - **Site URL**: your GitHub Pages URL, e.g.
     `https://yourusername.github.io/nmt-cbt/index.html`
   - **Redirect URLs**: add every page `signInWithGoogle()` might send
     people back to — at minimum:
     ```
     https://yourusername.github.io/nmt-cbt/index.html
     https://yourusername.github.io/nmt-cbt/login.html
     ```
     (Wildcards like `https://yourusername.github.io/nmt-cbt/*` are
     supported and simpler — use one if you'd rather not maintain this
     list by hand.)

## 5. Fill in `js/config.js`

Open `js/config.js` and replace the two placeholder values with your
real Project URL and anon key from step 1:

```js
export const SUPABASE_URL = "https://xxxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";
```

That's the only file that needs editing for the student site to work.
Commit it — these two values are meant to be public (see the file's own
header comment).

## 6. Bootstrap your own admin account

1. Deploy the site (or run it locally — see the existing README's
   `python -m http.server` instructions) and sign in once with **your
   own** Google account via `login.html`.
2. You'll land on `access-denied.html` — expected. The trigger created
   your `public.users` row, but it starts as `status = 'pending'`.
3. Back in the Supabase SQL Editor, run (replace with your real email):
   ```sql
   update public.users set status = 'active' where email = 'you@gmail.com';
   insert into public.admins (user_id)
     select id from public.users where email = 'you@gmail.com';
   ```
4. Sign in again (or just refresh if the tab is still open) — you now
   have an active, admin account. From here, the admin panel's user
   management screen (once built — see the project's continuation doc
   for what's Phase 2) is how you approve everyone else; you shouldn't
   need to touch SQL again after this one-time bootstrap.

## 7. Deploy the Edge Functions

Two Edge Functions exist, both server-side only:

- **`submit-attempt`** — the authoritative scoring path. Required for
  exam submission to work at all once migration `0002` is applied (see
  step 2) — without it deployed, students can start an exam but their
  submission will fail server-side (falling back to a local-only result
  that never reaches the dashboard or admin view).
- **`admin-revoke-session`** — only needed if you plan to use "Revoke
  Sessions" from the admin Users page.

```bash
npm install -g supabase   # if you don't have the CLI
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy submit-attempt
supabase functions deploy admin-revoke-session
```

No manual secrets to set — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` are automatically available to every Edge
Function in your project.

## Security architecture — who can see what, and when

**Before submission**, a student's browser can reach:
- The stripped version of a test's content — `question`, `options`,
  `marks`, `required`, images/audio URLs, section/group structure.
  **Never** `correctOption` or `explanation`.
- Nothing at all for a test they aren't granted, or that isn't
  `published` — not even a row exists as far as their query can tell.

This is enforced at the database level (`get_exam_content()` in
`0003_hide_answer_key.sql`), not by the UI declining to render a field —
a raw `supabase.from('tests').select('content')` call from devtools now
returns `permission denied for table tests` for every role, admins
included (verified against a real local Postgres instance, not just
reviewed). The only path to `content` is that one function, which
decides what to return based on who's actually calling it.

**At submission**, the browser sends raw answers only — `{questionId:
selectedOptionIndex}` pairs — never a score, never `isCorrect`, never
`correctOption`. The `submit-attempt` Edge Function loads the real
content itself (via the service-role key, which is exempt from the
column restriction above) and computes the score server-side. See that
function's own header comment for the full authoritative-scoring flow,
established in Session 16.

**After submission**, the server's computed result — which DOES include
`correctOption`/`explanation` per question, now that the student has
actually attempted it — is what the Review Answers screen reads. It
was never sourced from the original test content in the first place
(`review.js` has always read from the submitted result object, going
back to Session 15), so no separate change was needed there.

**Admins** always get the full content, including the answer key,
through the same `get_exam_content()` function — it branches on
`is_admin()` before deciding whether to strip anything. This is
deliberate: the admin editor, "Publish," and "Preview"/"Preview as
User" all need real answers to be useful.

**What this does NOT and cannot change:** a test's questions and
options still have to reach the browser to be displayed at all — this
was never about hiding the existence of a test, only its answer key.
And once a student has submitted, the server-returned result for THAT
attempt legitimately does contain the real answers (that's how Review
Answers works) — this doesn't, and structurally can't, prevent someone
from screenshotting or sharing their own graded review with someone who
hasn't taken the test yet. That's a human/policy problem, not a
software one.

## 8. Local development

`python -m http.server` (as before) works fine for local dev — Supabase
doesn't care where requests originate as long as the origin is in your
**Authorized JavaScript origins** (step 3) and your Supabase **Redirect
URLs** (step 4). Add `http://localhost:8000` (or whatever port you use)
to both if you want Google sign-in to work locally, not just on the
deployed GitHub Pages URL.

## 9. Production checklist

- [ ] Google OAuth consent screen is **Published** (not stuck in
      Testing with a test-user allowlist), unless you deliberately want
      to restrict who can even *attempt* Google sign-in.
- [ ] `js/config.js` has your real `SUPABASE_URL`/`SUPABASE_ANON_KEY`,
      committed.
- [ ] You've bootstrapped at least one admin account (step 6).
- [ ] `supabase/migrations/0002_protect_scoring.sql` has been applied
      (see step 2) AND `submit-attempt` is deployed (step 7) — without
      both together, exam submission will silently fall back to a
      local-only result that never reaches the dashboard.
- [ ] `supabase/migrations/0003_hide_answer_key.sql` has been applied
      (see step 2) — without it, `tests.content` (including every
      question's `correctOption`) is readable by any authorized student
      before they've answered anything.
- [ ] `supabase/functions/admin-revoke-session` is deployed if you plan
      to use session revocation from the admin panel.
- [ ] No `service_role` key appears anywhere in this repo's tracked
      files — `git grep -i "service_role"` should return nothing outside
      `supabase/functions/`.

---

## Environment variable summary

| Variable | Where it lives | Used for |
|---|---|---|
| `SUPABASE_URL` | `js/config.js` (public) | Every client-side Supabase call |
| `SUPABASE_ANON_KEY` | `js/config.js` (public) | Every client-side Supabase call — safe, RLS-protected |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Supabase dashboard → Auth → Providers → Google (never in this repo) | Supabase's server-side OAuth exchange |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Function runtime (auto-injected, never in this repo) | `admin-revoke-session` only |

Never commit a `service_role` key or a Google `Client Secret` to this
repository, in any file, ever.
