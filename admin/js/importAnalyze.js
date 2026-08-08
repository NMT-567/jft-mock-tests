/**
 * importAnalyze.js
 * Turns a raw "Selected_Mock_Tests.json"-shaped source document (the
 * export format used by the sibling nihongo-mock-test project, and by
 * this admin's own bulk exports) into an import PLAN — sections, groups,
 * questions, stats, and a list of anything that needed a judgment call —
 * without touching localStorage. Committing the plan (writing bank
 * entries, saving the draft) is a separate, later step (see
 * commitImportPlan) so the whole Upload -> Validate -> Preview pipeline
 * can run purely in memory and be shown to the admin before anything is
 * written.
 *
 * SCOPE: this file only understands the source shape used by the
 * uploaded JSON: { tests: [{ ...testFields, questions: [...] }] }, where
 * a "question" may actually be a PASSAGE HEADER (see isPassageHeader).
 * Files that already use this admin's own sections[]/groups[] v2 shape,
 * or the old groupId/groupType round-trip v1 shape, are unaffected —
 * import.js's existing importDocumentToDraft/importLegacyV1Test still
 * handle those; importFileToDraft (see below) picks the right path.
 */
import { generateId } from "./components.js?v=3";
import { getBankEntry, saveBankEntry, newBankEntry } from "./questionBank.js?v=4";

/**
 * The exam ALWAYS contains exactly these 4 sections (mirrors editor.js's
 * own FIXED_SECTIONS — duplicated here rather than imported since
 * editor.js doesn't export it and this file must also run from the
 * dashboard/import page, which never loads editor.js).
 */
export const FIXED_SECTIONS = [
  { key: "scripts", id: "sec-scripts", title: "Scripts & Vocabulary" },
  { key: "conversation", id: "sec-conversation", title: "Conversation & Expression" },
  { key: "listening", id: "sec-listening", title: "Listening" },
  { key: "reading", id: "sec-reading", title: "Reading" },
];

/* =========================================================
   PASSAGE HEADER DETECTION
   ========================================================= */
/**
 * A passage/group header is a record that isn't a real question at all:
 * zero options, no correct answer, zero marks, and an instructional
 * "answer the following N questions" sentence that DECLARES how many
 * child records follow it. Matches the spec's example exactly. Returns
 * the declared count N, or null if this isn't a header.
 */
export function detectPassageHeaderCount(raw) {
  const options = Array.isArray(raw.options) ? raw.options : [];
  if (options.length !== 0) return null;
  if (raw.correctOption) return null;
  if (raw.marks) return null;
  const match = /answer the following (\d+) questions?/i.exec(raw.question || "");
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Walks the raw questions[] array once, grouping each detected header
 * with exactly the N records that follow it (validating the declared
 * count actually matches what's there — a header near the end of the
 * array with fewer than N records remaining is flagged, not silently
 * truncated or overrun into the next header's territory).
 */
export function detectGroups(rawQuestions) {
  const items = []; // { kind: 'header'|'child'|'standalone', raw, headerId?, index }
  const warnings = [];
  let i = 0;
  while (i < rawQuestions.length) {
    const raw = rawQuestions[i];
    const n = detectPassageHeaderCount(raw);
    if (n === null) {
      items.push({ kind: "standalone", raw, index: i });
      i += 1;
      continue;
    }
    const available = rawQuestions.length - (i + 1);
    const take = Math.min(n, available);
    if (take < n) {
      warnings.push(`Header "${(raw.question || "").slice(0, 60)}" (id ${raw.id}) declares ${n} questions but only ${take} remain in the file — importing what's there and flagging it.`);
    }
    items.push({ kind: "header", raw, index: i, declaredCount: n, childCount: take });
    for (let k = 1; k <= take; k++) {
      items.push({ kind: "child", raw: rawQuestions[i + k], index: i + k, headerId: raw.id });
    }
    i += 1 + take;
  }
  return { items, warnings };
}

/* =========================================================
   SECTION CLASSIFICATION
   Every item gets a section + a confidence ("high" | "medium" | "low").
   Only "low" confidence items are surfaced as needing manual review —
   "medium" ones have a real positive content signal (an illustration
   instruction, an underlined word, an A:/B: exchange with a blank) and
   are auto-assigned without flagging; "low" ones are pure positional
   fallback (no content signal at all, inherited from a neighbor) and
   MUST be flagged per "do not guess silently".
   ========================================================= */
function strongSignal(item) {
  if (item.kind === "header" || item.kind === "child") return ["reading", "high"];
  const raw = item.raw;
  if (raw.audioUrl) return ["listening", "high"];
  const text = raw.question || "";
  if (/look at the illustration/i.test(text)) return ["scripts", "medium"];
  const hasBlank = /＿{2,}|_{3,}/.test(text);
  const isDialogue = /[AB]\s*[:：]/.test(text);
  if (isDialogue && hasBlank) return ["conversation", "medium"];
  if (/<u>.*?<\/u>/.test(text) && !isDialogue) return ["scripts", "medium"];
  return [null, null];
}

export function classifySections(items) {
  const results = items.map((item) => strongSignal(item));
  // Fill anything unresolved from the nearest already-classified neighbor
  // on either side — genuinely no content signal, so this is a positional
  // guess and always gets "low" confidence (flagged for manual review).
  for (let idx = 0; idx < items.length; idx++) {
    if (results[idx][0]) continue;
    let p = idx - 1;
    while (p >= 0 && !results[p][0]) p--;
    let n = idx + 1;
    while (n < items.length && !results[n][0]) n++;
    const prevSec = p >= 0 ? results[p][0] : null;
    const nextSec = n < items.length ? results[n][0] : null;
    results[idx] = [prevSec || nextSec || "scripts", "low"];
  }
  return results;
}

/* =========================================================
   VALIDATION
   ========================================================= */
export function validateSourceDocument(json) {
  const errors = [];
  if (!json || typeof json !== "object") {
    return { valid: false, errors: ["File does not contain a JSON object."] };
  }
  if (!Array.isArray(json.tests) || json.tests.length === 0) {
    errors.push("No tests[] array found (or it's empty) — nothing to import.");
    return { valid: false, errors };
  }
  const test = json.tests[0];
  if (!Array.isArray(test.questions)) {
    errors.push("The first test has no questions[] array.");
    return { valid: false, errors };
  }
  const seenIds = new Set();
  const dupeIds = new Set();
  test.questions.forEach((q, i) => {
    if (!q.id) errors.push(`Question at position ${i} has no id.`);
    else if (seenIds.has(q.id)) dupeIds.add(q.id);
    else seenIds.add(q.id);
    if (q.options !== undefined && !Array.isArray(q.options)) errors.push(`Question ${q.id || i}: options is not an array.`);
    const isHeader = detectPassageHeaderCount(q) !== null;
    if (!isHeader && Array.isArray(q.options) && q.options.length > 0) {
      if (q.correctOption !== undefined && q.correctOption !== null && q.correctOption !== "" && !q.options.includes(q.correctOption)) {
        errors.push(`Question ${q.id || i}: correctOption "${q.correctOption}" does not match any of its options.`);
      }
    }
  });
  if (dupeIds.size > 0) errors.push(`Duplicate question IDs within the file itself: ${[...dupeIds].join(", ")}`);
  return { valid: errors.length === 0, errors, test };
}

/* =========================================================
   PLAN BUILDING (pure — no localStorage access)
   ========================================================= */
/**
 * Builds a full, inspectable import plan from a validated source
 * document. Does NOT touch the Question Bank or draft storage — see
 * commitImportPlan for that. Bank-id-collision detection (against
 * whatever's ALREADY in the bank right now) is included here since it's
 * still read-only and belongs in the Preview step.
 */
export function buildImportPlan(json) {
  const { valid, errors, test } = validateSourceDocument(json);
  if (!valid) return { valid: false, errors };

  const { items, warnings } = detectGroups(test.questions);
  const classifications = classifySections(items);

  const bySection = { scripts: [], conversation: [], listening: [], reading: [] };
  const ambiguous = [];
  const passageGroups = [];
  let currentGroup = null;

  items.forEach((item, idx) => {
    const [sectionKey, confidence] = classifications[idx];
    if (confidence === "low") {
      ambiguous.push({ id: item.raw.id, question: item.raw.question, assignedSection: sectionKey, kind: item.kind });
    }
    if (item.kind === "header") {
      currentGroup = { headerId: item.raw.id, headerRaw: item.raw, declaredCount: item.declaredCount, childCount: item.childCount, sectionKey, children: [] };
      passageGroups.push(currentGroup);
      bySection[sectionKey].push({ kind: "group", group: currentGroup });
      return;
    }
    if (item.kind === "child") {
      if (currentGroup && currentGroup.headerId === item.headerId) currentGroup.children.push(item.raw);
      return; // children are represented via their parent group entry above, not a separate top-level bySection item
    }
    bySection[sectionKey].push({ kind: "standalone", raw: item.raw });
  });

  // Duplicate-ID-against-existing-bank check (read-only).
  const allRealQuestions = [];
  passageGroups.forEach((g) => g.children.forEach((c) => allRealQuestions.push(c)));
  items.filter((it) => it.kind === "standalone").forEach((it) => allRealQuestions.push(it.raw));
  const existingBankCollisions = allRealQuestions
    .filter((q) => !!getBankEntry(q.id))
    .map((q) => ({ id: q.id, question: q.question }));

  const stats = {
    fileTests: 1,
    fileQuestions: test.questions.length,
    realQuestions: allRealQuestions.length,
    passageGroups: passageGroups.length,
    listeningQuestions: allRealQuestions.filter((q) => !!q.audioUrl).length,
    imageQuestions: allRealQuestions.filter((q) => !!q.imageUrl).length + passageGroups.filter((g) => !!g.headerRaw.imageUrl).length,
    audioFiles: new Set(allRealQuestions.map((q) => q.audioUrl).filter(Boolean)).size,
    perSection: Object.fromEntries(
      FIXED_SECTIONS.map((fs) => [
        fs.key,
        bySection[fs.key].reduce((sum, it) => sum + (it.kind === "group" ? it.group.children.length : 1), 0),
      ])
    ),
  };

  // Flag (not silently resolve) any passage-group child that carries its
  // OWN imageUrl distinct from the group's shared one — this project's
  // schema has exactly one imageUrl slot per group, shared by every
  // child, so a child's own separate image has nowhere lossless to go.
  const imageConflicts = [];
  passageGroups.forEach((g) => {
    g.children.forEach((c) => {
      if (c.imageUrl && c.imageUrl !== g.headerRaw.imageUrl) {
        imageConflicts.push({ groupHeaderId: g.headerId, questionId: c.id, question: c.question, ownImageUrl: c.imageUrl, groupImageUrl: g.headerRaw.imageUrl });
      }
    });
  });

  return {
    valid: true,
    sourceTest: test,
    bySection,
    passageGroups,
    ambiguous,
    warnings,
    existingBankCollisions,
    imageConflicts,
    stats,
  };
}

/* =========================================================
   COMMIT (writes to the Question Bank + returns a draft to save)
   ========================================================= */
/**
 * `duplicateResolution`: "use-existing" | "create-copy" — how to handle
 * every question id in plan.existingBankCollisions. A single global
 * choice (not per-question) per the "keep it a simple workflow, no
 * nested dropdowns" brief — the Preview step lists every affected id so
 * the admin can see exactly what the choice applies to before picking it.
 */
export function commitImportPlan(plan, { mode = "new", existingDraftId = null, duplicateResolution = "use-existing" } = {}) {
  const idRemap = new Map(); // original source id -> actual bank id used (differs only under "create-copy")

  function importQuestion(raw) {
    const collision = !!getBankEntry(raw.id);
    let bankId = raw.id;
    if (collision) {
      if (duplicateResolution === "create-copy") {
        bankId = generateId("bq");
      }
      // "use-existing": keep raw.id, and DON'T overwrite the existing entry — skip the write below entirely.
    }
    if (!collision || duplicateResolution === "create-copy") {
      saveBankEntry(
        newBankEntry({
          id: bankId,
          question: raw.question || "",
          options: Array.isArray(raw.options) ? raw.options : [],
          correctOption: raw.correctOption ?? null,
          explanation: raw.explanation || "",
          marks: typeof raw.marks === "number" ? raw.marks : 1,
          difficulty: raw.difficulty || "medium",
          tags: Array.isArray(raw.tags) ? raw.tags : [],
        }),
        { touchModified: false }
      );
    }
    idRemap.set(raw.id, bankId);
    return { id: bankId };
  }

  const sections = FIXED_SECTIONS.map((fs) => {
    const entries = plan.bySection[fs.key];
    const groups = entries.map((entry) => {
      if (entry.kind === "group") {
        const g = entry.group;
        return {
          id: g.headerId,
          type: "passage_group",
          title: g.headerRaw.question || "",
          passageText: "",
          imageUrl: g.headerRaw.imageUrl || null,
          audioUrl: g.headerRaw.audioUrl || null,
          questions: g.children.map(importQuestion),
        };
      }
      const raw = entry.raw;
      return {
        id: generateId("group"),
        type: "single",
        title: "",
        imageUrl: raw.imageUrl || null,
        audioUrl: raw.audioUrl || null,
        questions: [importQuestion(raw)],
      };
    });
    return { id: fs.id, title: fs.title, groups };
  });

  const test = plan.sourceTest;
  const draft = {
    id: mode === "replace" && existingDraftId ? existingDraftId : generateId("test"),
    title: test.title || "Imported Test",
    categoryName: test.categoryName || test.categoryId || "General",
    topic: test.topic || "",
    description: "",
    language: "en",
    duration: typeof test.duration === "number" ? test.duration : 60,
    noTimeLimit: !!test.noTimeLimit,
    passMarks: typeof test.passMarks === "number" ? test.passMarks : null,
    active: test.active !== false,
    premium: !!test.premium,
    status: "draft",
    createdAt: test.createdAt || new Date().toISOString(),
    sections,
  };

  return { draft, idRemap };
}

/* =========================================================
   DATA INTEGRITY TEST — compares the source document against what's
   now actually in the Question Bank + draft, field by field.
   ========================================================= */
export function runIntegrityCheck(plan, draft, idRemap) {
  const mismatches = [];
  const sourceRealQuestions = [];
  plan.passageGroups.forEach((g) => g.children.forEach((c) => sourceRealQuestions.push(c)));
  Object.values(plan.bySection).forEach((entries) =>
    entries.forEach((e) => { if (e.kind === "standalone") sourceRealQuestions.push(e.raw); })
  );

  sourceRealQuestions.forEach((src) => {
    const bankId = idRemap.get(src.id) || src.id;
    const entry = getBankEntry(bankId);
    if (!entry) { mismatches.push({ id: src.id, field: "(entire question)", reason: "missing from bank after import" }); return; }
    const fields = ["question", "correctOption", "explanation", "marks"];
    fields.forEach((f) => {
      const sv = src[f] ?? (f === "marks" ? 1 : "");
      const ev = entry[f] ?? (f === "marks" ? 1 : "");
      if (JSON.stringify(sv) !== JSON.stringify(ev)) mismatches.push({ id: src.id, field: f, source: sv, imported: ev });
    });
    const srcOptions = Array.isArray(src.options) ? src.options : [];
    if (JSON.stringify(srcOptions) !== JSON.stringify(entry.options || [])) {
      mismatches.push({ id: src.id, field: "options", source: srcOptions, imported: entry.options });
    }
  });

  // Passage-group-level media (title/imageUrl/audioUrl on the group itself).
  plan.passageGroups.forEach((g) => {
    const section = draft.sections.find((s) => s.groups.some((gr) => gr.id === g.headerId));
    const group = section && section.groups.find((gr) => gr.id === g.headerId);
    if (!group) { mismatches.push({ id: g.headerId, field: "(passage group)", reason: "missing from draft after import" }); return; }
    if ((g.headerRaw.imageUrl || null) !== (group.imageUrl || null)) {
      mismatches.push({ id: g.headerId, field: "group.imageUrl", source: g.headerRaw.imageUrl, imported: group.imageUrl });
    }
  });

  const importedRealQuestionCount = draft.sections.reduce(
    (sum, s) => sum + s.groups.reduce((gs, g) => gs + g.questions.length, 0),
    0
  );
  // Counted from what's ACTUALLY in the draft, not assumed from the
  // source — a source question can have an imageUrl that never made it
  // into any group (see knownImageConflicts), and this count must not
  // paper over that by equaling the source count anyway.
  const importedImageCount = draft.sections.reduce((sum, s) => sum + s.groups.filter((g) => !!g.imageUrl).length, 0);
  const importedAudioCount = draft.sections.reduce((sum, s) => sum + s.groups.filter((g) => !!g.audioUrl).length, 0);

  return {
    sourceCounts: {
      tests: 1,
      questions: sourceRealQuestions.length,
      passageGroups: plan.passageGroups.length,
      images: plan.stats.imageQuestions,
      audio: plan.stats.audioFiles,
    },
    importedCounts: {
      tests: 1,
      questions: importedRealQuestionCount,
      passageGroups: draft.sections.reduce((sum, s) => sum + s.groups.filter((g) => g.type === "passage_group").length, 0),
      images: importedImageCount,
      audio: importedAudioCount,
    },
    dataLoss: mismatches.length,
    duplicates: 0, // commitImportPlan never creates a duplicate id — "create-copy" always mints a fresh one
    mismatches,
    knownImageConflicts: plan.imageConflicts,
  };
}
