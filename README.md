# Nihongo Mock Test — CBT Practice Platform

A production-ready web application that replicates the Japanese
**JFT-Basic Computer Based Test (CBT)** exam experience. The exam UI
itself is framework-free (**HTML5, CSS3, vanilla ES6 modules** — no
React, no Vue) and runs on **GitHub Pages**. Since §10 (Session 15/16),
it's backed by **Supabase** (Google OAuth, Postgres, Row Level Security)
for real authentication, per-test access control, and attempt tracking —
see §10 for the full picture and `SETUP_SUPABASE_AUTH.md` for setup.

---

## 1. Features

- Four exam **sections** (e.g. Scripts & Vocabulary, Conversation & Expression, Listening, Reading), each shown with a real-CBT-style section banner
- **Grouped questions**: Single Question, Passage Group, Conversation Group, Listening Group, Image Group — shared passage/conversation/media rendered once, all related questions underneath
- Next/Previous move between **groups**, not individual questions; the question palette still lists every question individually and jumps straight to it (switching group + scrolling)
- Text, image, audio, reading-passage, and conversation question types, dynamically loaded from a single JSON file (no hardcoded questions)
- Countdown timer with color-coded warnings (orange < 10 min, red < 5 min) and auto-submit
- Auto-save to `localStorage` (answers, bookmarks, current group, remaining time) with session resume after refresh
- Real authentication (`login.html`): "Continue with Google" via Supabase Auth, backed by an admin-controlled allowlist and per-test access grants — see §10
- Exam-integrity lockdown: right-click/copy/paste/select disabled, keyboard-shortcut blocking, fullscreen enforcement, best-effort DevTools detection, and a bounded tab-visibility violation counter (see `js/security.js`'s header comment for exactly what is and isn't actually enforceable)
- Keyboard navigation (← / →), question search/jump
- Submit confirmation with Answered / Unanswered / Bookmarked breakdown
- Result page: score, percentage, pass/fail, progress ring — no download/print/export (removed by design; see §9)
- Review page: every question with correct vs. given answer, explanation, filters (All / Correct / Wrong / Skipped / Bookmarked)
- Dark mode (persisted), fullscreen mode, fully responsive (desktop / tablet / mobile), mobile-first layout (bottom nav + bottom-sheet palette)

---

## 2. Folder Structure

```
/
├── login.html            Password gate (see §9) — the actual entry point
├── index.html             Home / start screen
├── exam.html               Exam-taking screen (sections + grouped questions)
├── result.html              Score summary screen
├── review.html               Full answer review screen
├── css/
│   ├── style.css          Design tokens, layout, home page, shared components
│   ├── exam.css             Exam page: section banner, groups, timer, palette, security overlays
│   ├── result.css           Result page (progress ring, stat grid)
│   ├── review.css           Review page (filters, review cards)
│   └── responsive.css      Mobile-first base + tablet/desktop scale-up
├── js/
│   ├── config.js           Public Supabase URL/anon key (see §10)
│   ├── auth.js               Password check + sessionStorage login state
│   ├── login.js                Login page controller
│   ├── loader.js                Fetches & normalizes /data JSON (sections → groups → questions)
│   ├── groupRenderer.js          Shared DOM builder for section/group/question content —
│   │                              used by BOTH the real exam and the admin's live preview
│   ├── app.js                Home page controller
│   ├── exam.js                 Exam engine controller (group/section navigation, ties everything together)
│   ├── security.js               Exam-integrity lockdown (see its header comment)
│   ├── timer.js                Countdown timer class
│   ├── palette.js                Question palette (still per-question) + group-completion check
│   ├── navigation.js               Keyboard nav, jump-to-question, swipe-to-close
│   ├── storage.js                 localStorage session + result persistence
│   ├── review.js                  Review page controller
│   ├── result.js                   Result page controller (no download/print — see §9)
│   └── utils.js                     Shared helpers (formatting, theme, escaping)
├── data/
│   ├── Selected_Mock_Tests.json   Test data (sections → groups → questions — see §5)
│   └── settings.json                Editable site settings (title, logo, theme, timer/passing defaults)
├── admin/                See admin/README.md — the test-authoring tool
├── assets/
│   ├── icons/logo.svg
│   └── fonts/            (optional custom fonts)
└── README.md
```

---

## 3. Running Locally

Browsers block `fetch()` on `file://` URLs, so you need a tiny local server:

```bash
# Python 3
python3 -m http.server 8080

# or Node
npx serve .
```

Then open `http://localhost:8080`.

---

## 4. Deploying to GitHub Pages

1. Push this folder to a GitHub repository (root, or a `/docs` folder).
2. In the repo: **Settings → Pages → Source** → select the branch (and `/docs`
   folder if used).
3. Save. GitHub will publish at `https://<username>.github.io/<repo>/`.
4. No build step is required — it's static HTML/CSS/JS.

---

## 5. JSON Data Format

The app reads `data/Selected_Mock_Tests.json` — a **single test**, not an
array of tests, structured as sections → groups → questions:

```jsonc
{
  "formatVersion": 2,
  "source": "nmt-admin",
  "id": "unique-test-id",
  "title": "JFT-Basic Mock Test 1",
  "categoryName": "JFT Basic",
  "topic": "August & September Set",
  "duration": 60,              // minutes; ignored if noTimeLimit is true
  "noTimeLimit": false,
  "passMarks": 200,
  "sections": [
    {
      "id": "sec-1",
      "title": "Scripts & Vocabulary",   // shown to students exactly as-is
      "groups": [
        {
          "id": "g1",
          "type": "single",              // single | passage_group | conversation_group | listening_group | image_group
          "imageUrl": "https://.../image.webp",  // optional, per group
          "audioUrl": null,
          "questions": [
            {
              "id": "q1",
              "question": "Look at the illustration and choose the correct word.",
              "options": ["といる", "といれ", "トイレ"],
              "correctOption": "トイレ",
              "explanation": "",
              "marks": 3
            }
          ]
        },
        {
          "id": "g2",
          "type": "passage_group",
          "title": "Passage 1",
          "passageText": "Read the passage below...",
          "questions": [ /* 2-5 question objects, same shape as above */ ]
        }
      ]
    }
  ]
}
```

**Group types:**
- `single` — one question, with optional `imageUrl`/`audioUrl` on the group
- `passage_group` — shared `passageText` (+ optional image/audio), 2-5 questions
- `conversation_group` — shared `speakerAName`/`speakerAText`/`speakerBName`/`speakerBText` + required `audioUrl`, 2-5 questions
- `listening_group` — shared `audioUrl` (required), any number of questions — students must answer all of them before advancing
- `image_group` — shared `imageUrl` (required), any number of questions

Question numbering, the palette, and scoring are all computed by
`js/loader.js` from this structure — every question across every
section/group gets one global sequential number, exactly as a real CBT
exam numbers them.

---

## 6. Customization

- **Branding**: replace `assets/icons/logo.svg` and the `--color-primary`
  token in `css/style.css`.
- **Theme colors**: all colors are CSS custom properties in `:root` and
  `html[data-theme="dark"]` inside `css/style.css` — change once, applies
  everywhere.
- **Pass logic**: controlled by each test's `passMarks` field (marks
  scored must meet or exceed it) — no code changes needed.
- **Timer warning thresholds**: `WARNING_THRESHOLD_SECONDS` /
  `DANGER_THRESHOLD_SECONDS` constants in `js/timer.js`.

---

## 7. Adding New Tests

Each `Selected_Mock_Tests.json` file holds **one** test (matching the admin
panel's one-test-at-a-time model). To publish a different test:

1. Build it in `admin/` and click **Export JSON**, or hand-edit a copy of
   the file following the schema in §5.
2. Replace `data/Selected_Mock_Tests.json` with it.

No other files need to change — everything downstream (section banners,
palette size, timer duration, pass calculation, review screen) is derived
from the JSON.

---

## 8. Browser Storage Notes

All session state (`nmt_session_v1`) and the last completed result
(`nmt_last_result_v1`) live in `localStorage` under the current origin.
Clearing site data will remove in-progress sessions and the most recent
local result copy. Real login state is a Supabase session (persisted via
`supabase-js`'s own `localStorage` usage, not something this project
manages directly) — see §9.

---

## 9. Login / Authentication

`login.html` sits in front of the whole student site — but as of the
Supabase integration (see §10), this is now **real authentication**, not
a casual gate. Login is "Continue with Google" via Supabase Auth +
Google OAuth; every other student page (`index.html`, `exam.html`,
`result.html`, `review.html`) calls `js/auth.js`'s `requireAuth()` on
load, which checks the actual Supabase session and redirects to
`login.html` (no session) or `access-denied.html` (signed in, but not
yet approved by an admin — see §10's allowlist explanation) — this is an
async check against a real backend, not a synchronous localStorage read,
so protected pages briefly show a loading state while it resolves rather
than blocking on it inline in `<head>`.

The old shared-password gate (`EXAM_PASSWORD`, `data/settings.json`'s
`password` field, `sessionStorage.nmt_authenticated`) has been fully
removed, not kept as a fallback — see §10 for what replaced it.

**Removed by design:** the result page has no download, print, or JSON
export of any kind — students can Review Answers or Return Home, nothing
else. (The admin panel's own **Export JSON** button is unrelated and
still works — it downloads `data/Selected_Mock_Tests.json` for the old
static-file path. The primary path since §10 is **Publish to
Supabase**, a separate button in the editor that pushes the same
content into the `tests` table instead.)

---

## 10. Supabase Backend (Auth, Access Control, Attempts)

Since Session 15/16, the student site's authentication, per-test access
control, and attempt/result tracking are backed by Supabase — Google
OAuth via Supabase Auth, Postgres, and Row Level Security enforcing
authorization server-side (not just hiding buttons in the UI). The exam
content itself (`data/Selected_Mock_Tests.json`'s shape) is unchanged —
see §5 — it's just also stored in a Supabase `tests` table now, alongside
the static file, not replacing it (see §10.7).

**Full step-by-step setup lives in [`SETUP_SUPABASE_AUTH.md`](./SETUP_SUPABASE_AUTH.md)
— this section is a map of what's there and how the pieces fit together,
not a duplicate of the instructions themselves.**

### 10.1 Local Development

Same as §3 — `python -m http.server` (or any static server; not
`file://`, since Supabase Auth's redirect flow and this project's ES
modules both need a real origin). The only extra step: add your local
URL (e.g. `http://localhost:8000`) to both Google Cloud's *Authorized
JavaScript origins* and Supabase's *Redirect URLs* — see
`SETUP_SUPABASE_AUTH.md` §8.

### 10.2 Supabase Setup

Create a project, run the three migrations in order
(`0001_init.sql`, `0002_protect_scoring.sql`, `0003_hide_answer_key.sql`),
copy your Project URL + anon key into `js/config.js`. Full details:
`SETUP_SUPABASE_AUTH.md` §§1-2, §5.

### 10.3 Google OAuth Setup

Create a Google Cloud OAuth client (Web application type), point its
redirect URI at Supabase's own callback URL (not your GitHub Pages URL —
Supabase sits in between), wire the Client ID/Secret into Supabase's
Auth provider settings. Full click-by-click walkthrough:
`SETUP_SUPABASE_AUTH.md` §§3-4.

### 10.4 Database Migrations

Seven migration files, run in order:
- `0001_init.sql` — `users`/`admins`/`tests`/`test_access`/`test_attempts`
  tables, RLS policies, the auto-provisioning trigger that creates a
  `pending` user row on first Google sign-in.
- `0002_protect_scoring.sql` — a trigger that blocks any client (even the
  row's own owner) from directly writing `status`/`score`/`result` on
  `test_attempts`; only the `submit-attempt` Edge Function (server-side,
  recomputes the score itself) can do that. Without this migration
  applied, a student could forge their own score via devtools.
- `0003_hide_answer_key.sql` — revokes direct column access to
  `tests.content` for every role (including admins), and adds
  `get_exam_content()` as the only path to it: admins get the real
  content back, everyone else gets a version with `correctOption`/
  `explanation` stripped from every question, server-side, before it
  ever reaches the browser. Without this migration applied, an
  authorized student's normal test-loading request also hands them the
  full answer key. See `SETUP_SUPABASE_AUTH.md`'s "Security
  architecture" section for the full before/after picture.
- `0004_grant_tests_write.sql` — grants the base `INSERT`/`UPDATE`/
  `DELETE` table privileges on `tests` to `authenticated`. A correct,
  harmless baseline to have regardless — but on further investigation
  (see `0005`) it turned out NOT to be the actual cause of the publish
  failure some projects hit; keep reading.
- `0005_publish_function.sql` — the actual fix for "Publish to
  Supabase" failing with `permission denied for table tests`, root-
  caused against a real Postgres instance rather than guessed: a plain
  `upsert()` whose payload includes `content` generates SQL referencing
  `excluded.content` in its `ON CONFLICT` clause, which requires SELECT
  privilege on that column — a privilege `0003` deliberately withholds
  from every role, admins included. This migration adds a `SECURITY
  DEFINER` function, `publish_test()`, which writes with the function
  owner's privileges instead and checks `is_admin()` explicitly rather
  than relying on the column-grant system — `admin/js/publish.js` calls
  this function now, not a direct table upsert. `0003`'s protection is
  completely untouched by this.
- `0006_fix_test_id_mapping.sql` — fixes a second, separate problem:
  local editor drafts have ids like `test-mskidqg4-wvi7tt` (never a
  UUID — see `admin/js/components.js`'s `generateId()`), while
  `tests.id` is UUID-typed. Publishing a real draft failed with
  `invalid input syntax for type uuid`. Adds a `local_draft_id text
  unique` column as the stable republish key; `publish_test()` now
  matches on that instead of accepting a client-supplied id at all —
  `tests.id` stays a real, database-generated UUID, and
  `test_access`/`test_attempts`'s foreign keys are completely
  unaffected (they only ever referenced the real UUID to begin with).
  Also fixed the same class of bug found lurking in `js/exam.js` (it
  was passing the content-embedded draft id — not the real UUID — to
  `test_attempts.test_id`), which would have surfaced as the identical
  error the first time a real student started a real published exam.
- `0007_student_allowlist.sql` — manual student pre-invitation. Adds an
  `invited_students` table (admin-only; a `public.users` row can only
  ever exist for someone who's already signed in — see that migration's
  comment for why a separate table is genuinely needed) and updates
  `handle_new_auth_user()` to check it: a matching invite lands `active`
  on first sign-in instead of `pending`. Everything else about the
  trigger — populating `display_name`/`avatar_url`/`email`/
  `last_login_at` from the real Google identity, never touching an
  admin-set `status` on later logins — is unchanged (and, as a related
  improvement made while touching this function, `display_name`/
  `avatar_url` now also stay in sync on every later login, not just the
  very first one).

### 10.5 Edge Functions

Two, both deployed via `supabase functions deploy <name>`:

- `submit-attempt` — **required** for exam submission to actually reach
  the dashboard/admin view once `0002` is applied (see §10.4). Client
  sends raw answers, never a score; this function loads the real test
  content and recomputes everything server-side.
- `admin-revoke-session` — only needed for the admin Users page's
  "Revoke Sessions" button.

### 10.6 Admin Setup — bootstrapping your first admin account

There's no way to become an admin through the UI (that would be
circular). One-time only, after your first Google sign-in:

```sql
update public.users set status = 'active' where email = 'you@gmail.com';
insert into public.admins (user_id)
  select id from public.users where email = 'you@gmail.com';
```

Run this in the Supabase SQL Editor. After this, use `admin/users.html`
to approve everyone else — you shouldn't need to touch SQL again.

### 10.7 User Allowlist

`admin/users.html`. Two ways a student gets approved:

1. **They sign in first, you approve after.** Every Google account that
   ever attempts sign-in gets a `public.users` row automatically,
   starting `status = 'pending'` — a `pending` account sees "Access not
   approved" and cannot reach any test. An admin flips them to `active`
   (or `disabled` to revoke) from this page.
2. **You invite them first, they get approved automatically.** The "Add
   Student" form only needs an email — no name, no profile picture, no
   password. That email is stored in `invited_students` (separate from
   `public.users`, since a `public.users` row can't exist until someone
   has actually signed in at least once). The first time they sign in
   with a matching Google account, they land `active` immediately — no
   separate manual approval step needed, since adding them to the
   invite list already was the approval. An invited-but-not-yet-signed-
   in email shows as its own row ("Not signed in yet" / "Invited") until
   that happens, then it's replaced by their real profile.

Search, per-user "Revoke Sessions", and an "Allow All Tests" toggle all
live here too.

### 10.8 Test Access

Two ways a `tests` row becomes visible to a student:
1. `users.allow_all_tests = true` for that user (the "Allow All Tests"
   quick action), or
2. an explicit row in `test_access` for that specific user + test.

Both are managed from the same `admin/users.html` "Manage Access"
dialog, per user. A test also has to be `status = 'published'`
(`admin/tests.html`) — a `draft` or `archived` test is never shown to an
ordinary user regardless of access grants (admins can still see/preview
any status).

Publishing itself happens from the **editor**, not the Users/Tests admin
pages: open a test in `admin/editor.html`, click **Publish to
Supabase** (separate from the pre-existing **Export JSON**, which still
works independently and is unrelated). This pushes the exact same
exported content into a `tests` row, matched by the draft's own id.

### 10.9 GitHub Pages Deployment

Deployment itself is unchanged from §4 (push to a `gh-pages` branch or
enable Pages on `main` — nothing here needs a build step). What's new is
that your GitHub Pages URL has to be registered in two other places
*before* Google sign-in will work there:
- Google Cloud Console's *Authorized JavaScript origins*
- Supabase's *Site URL* / *Redirect URLs*

See `SETUP_SUPABASE_AUTH.md` §§3-4 for exactly where to add it.

### 10.10 Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Continue with Google" does nothing / console error | `js/config.js` still has placeholder `SUPABASE_URL`/`SUPABASE_ANON_KEY` |
| Redirects to Google, then to a Google error page | Google Cloud's redirect URI doesn't exactly match `https://<project-ref>.supabase.co/auth/v1/callback` |
| Redirects back to your site, but lands on a blank/error page instead of the dashboard | Your GitHub Pages URL isn't in Supabase's *Redirect URLs* list (Authentication → URL Configuration) |
| Signed in, but stuck on "Access not approved" forever | Expected for a brand-new account — an admin must set `status = 'active'` (§10.6/§10.7) |
| Dashboard shows no tests at all for an active user | Test isn't `published`, or the user has no `test_access` grant / `allow_all_tests` — check `admin/tests.html` and `admin/users.html` |
| Exam finishes, but the result never shows up in "My Results" or the admin view | `submit-attempt` Edge Function isn't deployed, or migration `0002` wasn't run — see §10.4-10.5. The student still sees a result (local fallback), it just never reaches Supabase |
| "Revoke Sessions" button errors | `admin-revoke-session` Edge Function isn't deployed |
| Exam won't load — "This test is unavailable, or you're not authorized" even for a properly granted, published, active user | `0003_hide_answer_key.sql` wasn't applied, or was applied against a project where `0001`/`0002` weren't — `get_exam_content()` depends on `is_admin()`/`has_test_access()` from `0001` |
| "Couldn't submit" retry modal appears every time, even online | `submit-attempt` isn't deployed, or migration `0003` revoked `content` access that the function's OWN reads unexpectedly depend on — check the function is connecting with the service-role key, not the anon key |
| "Publish to Supabase" fails with `permission denied for table tests` | Migration `0005_publish_function.sql` hasn't been applied — a plain upsert whose payload includes `content` requires SELECT privilege on that column (which `0003` deliberately withholds from every role), so publishing must go through the `publish_test()` RPC instead. Run `0005`. (`0004` alone does NOT fix this — it addresses a different, narrower grant that turned out not to be the actual cause on most projects. If the error instead says "new row violates row-level security policy," that's unrelated — check you're actually signed in as an admin.) |
| "Publish to Supabase" fails with `invalid input syntax for type uuid: "test-..."` | Migration `0006_fix_test_id_mapping.sql` hasn't been applied — local editor draft ids are never UUIDs, but `tests.id` is UUID-typed. Run `0006`, which adds a separate `local_draft_id` mapping column instead of trying to use the draft id as the real `id`. |
