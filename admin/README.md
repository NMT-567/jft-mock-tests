# NMT Admin — Test Builder

A standalone, framework-free admin panel for creating, editing, previewing,
and exporting the JSON consumed by the student CBT app (`../index.html`
and friends). Built with the same constraints as the student site: plain
**HTML5, CSS3, and vanilla JavaScript (ES6 modules)** — no React, no
backend, no login. Runs entirely on GitHub Pages, side-by-side with the
student app in an `/admin` subfolder.

---

## 1. What this is (and isn't)

- **Is:** a local content-authoring tool. Everything — drafts, uploaded
  images/audio, settings — lives in this browser's `localStorage`. Nothing
  is uploaded anywhere; there is no server, no login, and no analytics.
- **Isn't:** another copy of the student exam. It never renders a timed,
  gradeable exam session — only a read-only preview of how one would look.

---

## 2. Folder Structure

```
admin/
├── index.html          Dashboard: create / open / import / recent tests / settings
├── editor.html           Main editor: toolbar, sidebar, form panel, live preview
├── preview.html            Full-test read-only walkthrough (same look as the real exam)
├── css/
│   ├── style.css           Dashboard-specific styles (builds on ../css/style.css tokens)
│   ├── editor.css          Toolbar, sidebar tree, form panel, preview pane, floating save
│   └── responsive.css      Tablet/mobile: dashboard grid + off-canvas editor panels
├── js/
│   ├── app.js               Dashboard controller
│   ├── editor.js             Editor controller (the core of the admin panel)
│   ├── preview.js              Shared preview renderer + preview.html's page controller
│   ├── storage.js              localStorage: drafts index, autosave, settings
│   ├── export.js               Draft → student-site-compatible JSON
│   ├── import.js                Student-site JSON → draft (reconstructs groups)
│   ├── validator.js              Pre-export validation rules
│   └── components.js             Shared DOM builders, toasts, file-reading, confirm dialogs
└── assets/
```

Note: several files are **reused directly from the student site** via
relative paths rather than duplicated — `../css/style.css` and
`../css/exam.css` for design tokens and exam-screen styling,
`../../js/utils.js` for shared helpers, and — most importantly —
`../../js/groupRenderer.js`, which builds the actual DOM for a group's
shared passage/conversation/media block and its question cards. Both
`js/exam.js` (interactive) and `admin/js/preview.js` (read-only) call the
exact same functions, so the live preview and the standalone
`preview.html` walkthrough can never visually drift from what students
actually see.

---

## 3. Running Locally

Same as the student app — `fetch`/module imports need a real server, not `file://`:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/admin/`.

---

## 4. The Data Model

A test **draft** mirrors the exported JSON almost exactly now — sections
containing groups containing questions:

```js
draft = {
  id, title, categoryName, topic, description, language,
  duration, noTimeLimit, passMarks, active, premium, createdAt,
  sections: [
    {
      id, title,   // shown to students exactly as-is, as a section banner
      groups: [
        {
          id, type: "single" | "passage_group" | "conversation_group" | "listening_group" | "image_group",
          title,                                 // passage/conversation title
          passageText,                            // passage_group only
          speakerAName, speakerAText,             // conversation_group only
          speakerBName, speakerBText,             // conversation_group only
          imageUrl, audioUrl,                     // shared media for the group
          questions: [
            { id, question, options: [4], correctOption, explanation, marks }
          ]
        }
      ]
    }
  ],
}
```

A `single`-type group always has exactly 1 question; every other group
type holds 2–5 (enforced by `js/validator.js`).

### Export compatibility contract

`js/export.js` maps this almost 1:1 into the schema `js/loader.js` expects
on the student site (documented at the top of both files):

```
{ formatVersion: 2, source, exportedAt,
  id, title, categoryName, topic, duration, noTimeLimit, passMarks,
  sections: [{ id, title,
    groups: [{ id, type, title, passageText, speakerAName, speakerAText,
                speakerBName, speakerBText, imageUrl, audioUrl,
                questions: [{ id, question, options, correctOption,
                              explanation, marks }] }] }] }
```

Because the draft and export shapes are already this close, `js/import.js`
is mostly straight field-mapping — no group-reconstruction heuristics
needed like the old flat-question schema required.

---

## 5. Question Types (Group Types)

| Type | Shared content | Questions | Notes |
|---|---|---|---|
| Single Question | none (optional image/audio on the group) | 1 | The old "Image Question"/"Listening Question" types are now just a `single` group with `imageUrl`/`audioUrl` set |
| Passage Group | Title, passage text, optional image/audio | 2–5 | Passage shown once, questions underneath |
| Conversation Group | Title, Speaker A/B name + dialogue, required audio | 2–5 | Dialogue rendered as chat-style bubbles in both the exam and preview |
| Listening Group | Required audio | 2–5 | Students must answer every question in the group before the exam lets them advance |
| Image Group | Required image | 2–5 | |

Every question, regardless of its group, has: Question text, 4 options,
correct answer, explanation, marks.

---

## 6. Validation

Before export (`js/validator.js`), the editor checks:

- Test name, duration (or "No Time Limit"), and passing marks are set
- Every question has text, exactly 4 filled options, and a correct answer
  that matches one of them
- Marks are a positive number
- Image questions have an image; listening questions have audio;
  conversation groups have both dialogue blocks and audio
- Passage/conversation groups have 2–5 questions

Errors are listed in a dialog and export is blocked until they're fixed.

---

## 7. Media Uploads

Since there's no backend, uploaded images/audio are read as `data:` URLs
(`js/components.js`'s `readFileAsDataUrl`) and embedded directly in the
draft and the exported JSON. This keeps "nothing uploaded anywhere"
literally true, at the cost of larger JSON files for image/audio-heavy
tests — for a production test bank you may still prefer hosting media
externally (ImageKit, R2, etc.) and pasting URLs instead; the editor
doesn't currently expose a "paste URL instead of upload" field, but any
`imageUrl`/`audioUrl` value — data URL or plain URL — works identically
for both the exam and the export, so you can freely edit those fields in
the exported JSON by hand if you prefer external hosting.

---

## 8. Auto Save

Every edit debounces a save to `localStorage` (`js/storage.js`), keyed by
the draft's id, plus a lightweight summary used for the dashboard's
"Recent Tests" list. Closing the tab also force-saves via `beforeunload`.
The floating Save button in the editor reflects live save status and can
also be clicked to force an immediate save.

---

## 9. Known Limitations

- **Browser storage only.** Clearing site data removes all drafts —
  export important tests to JSON as a backup.
- **Data URLs bloat JSON size** for media-heavy tests (see §7).
- **Drag-and-drop reordering** uses native HTML5 DnD, which has inconsistent
  touch support on some mobile browsers — reordering is easiest on desktop.
- Import expects a v2 file (a `sections[]` array at the top level — one
  test per file, matching this admin's one-test-at-a-time model). Older
  flat-question exports aren't supported by this version of the admin.
