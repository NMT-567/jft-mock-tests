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
import { generateId, slugify } from "./components.js?v=3";
import { getBankEntry, saveBankEntry, newBankEntry } from "./questionBank.js?v=4";

/**
 * Default sections for a brand-new BLANK test created in the admin
 * (not imported) — a reasonable, familiar starting point. Imports no
 * longer force everything into these 4 — see classifySections below —
 * this list is now only the "new test" default and the last-resort
 * fallback label set for content with no section info at all.
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
 * zero options, no correct answer, and an instructional "answer the
 * following N questions" sentence that DECLARES how many child records
 * follow it. Matches the spec's example exactly. Returns the declared
 * count N, or null if this isn't a header.
 *
 * Deliberately does NOT gate on marks (an earlier version required
 * marks to be falsy too) — real source data has surfaced a header
 * record with a stray nonzero marks value (a leftover default from the
 * sibling project's authoring tool, not a meaningful score) that is
 * still unmistakably a header by every other signal: zero options, no
 * correct answer, and the exact declarative sentence. Zero options
 * alone already makes it un-scoreable regardless of what marks says.
 *
 * The declared count is matched as EITHER an ASCII digit OR a
 * full-width Japanese digit (U+FF10-U+FF19, e.g. "５") — real source
 * data has a header written as "...following ５ questions" (a mix of
 * English instruction text with a full-width numeral, presumably typed
 * on a Japanese IME), which plain \d does not match at all since it
 * only recognizes ASCII 0-9. Full-width digits are normalized to ASCII
 * before parsing so the declared count still comes out as a real number
 * either way.
 */
export function detectPassageHeaderCount(raw) {
  const options = Array.isArray(raw.options) ? raw.options : [];
  if (options.length !== 0) return null;
  if (raw.correctOption) return null;
  const match = /answer the following ([0-9０-９]+) questions?/i.exec(raw.question || "");
  if (!match) return null;
  const normalized = match[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xff10 + 0x30));
  return parseInt(normalized, 10);
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
/**
 * Picks whichever exact string the majority of a group's children carry
 * in their own `section` field, VERBATIM (original casing/spacing, not
 * normalized/collapsed) — used to title a passage/listening group when
 * its own `type` doesn't map to something more specific. Returns null
 * if no child has a usable section string at all.
 */
function majoritySectionLabel(children) {
  const counts = new Map();
  children.forEach((c) => {
    const label = (c.section || "").trim();
    if (!label) return;
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  let best = null;
  let bestCount = 0;
  counts.forEach((count, label) => {
    if (count > bestCount) { best = label; bestCount = count; }
  });
  return best;
}

function strongSignal(item) {
  if (item.kind === "header" || item.kind === "child") return ["Reading", "high"];
  const raw = item.raw;
  // Trust the source document's own `section` field first, VERBATIM —
  // it's the admin's explicit, authoritative tagging from the source
  // project's Question Bank, and should always outrank a guess from
  // question content. Previously this was passed through
  // normalizeSourceSection() and collapsed into one of 4 fixed keys
  // (e.g. "Kanji Reading" and "Reading Comprehension" would both become
  // just "reading", losing the actual original section name entirely).
  // Now the exact string IS the section — no collapsing, no renaming.
  const label = (raw.section || "").trim();
  if (label) return [label, "high"];
  // No section field at all on this question — fall back to guessing
  // from content, same heuristics as before, but returning a
  // human-readable fallback title (there's no original name to
  // preserve here, since the source never had one for this question).
  if (raw.audioUrl) return ["Listening", "high"];
  const text = raw.question || "";
  if (/look at the illustration/i.test(text)) return ["Scripts & Vocabulary", "medium"];
  const hasBlank = /＿{2,}|_{3,}/.test(text);
  const isDialogue = /[AB]\s*[:：]/.test(text);
  if (isDialogue && hasBlank) return ["Conversation & Expression", "medium"];
  if (/<u>.*?<\/u>/.test(text) && !isDialogue) return ["Scripts & Vocabulary", "medium"];
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
    results[idx] = [prevSec || nextSec || "Scripts & Vocabulary", "low"];
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

/**
 * Builds passage groups directly from the source document's real
 * `groups[]` array + each question's `questionGroupId` — the actual
 * data model used by the sibling nihongo-mock-test project (see
 * questionGroupService.js there), rather than guessing group
 * boundaries from an instructional sentence in the question text.
 * Returns null if the source has no `groups[]` at all, so callers can
 * fall back to the older text-heuristic detectGroups() for exports
 * made before this data was included.
 *
 * `fromSourceGroup: true` is stamped on every returned group so
 * downstream image-conflict checking (designed for the old
 * text-heuristic format, which assumed one shared image per group —
 * a concept that doesn't exist in this real schema, where only
 * passageText/audioUrl are shared and every question keeps its own
 * imageUrl) can skip these entirely instead of falsely flagging every
 * grouped question's image as a "conflict".
 */
function detectGroupsFromSource(test) {
  if (!Array.isArray(test.groups) || test.groups.length === 0) return null;

  const groupsById = new Map(test.groups.map((g) => [g.id, g]));
  const passageGroups = [];
  const groupsByOrder = new Map(); // headerId -> passageGroups entry, built in question order
  const standaloneItems = [];
  const warnings = [];

  test.questions.forEach((raw, index) => {
    if (!raw.questionGroupId) {
      standaloneItems.push({ kind: "standalone", raw, index });
      return;
    }
    const g = groupsById.get(raw.questionGroupId);
    if (!g) {
      warnings.push(`Question "${(raw.question || "").slice(0, 60)}" (id ${raw.id}) references group id ${raw.questionGroupId}, which isn't in this file's groups[] — importing it as standalone instead.`);
      standaloneItems.push({ kind: "standalone", raw, index });
      return;
    }
    let entry = groupsByOrder.get(g.id);
    if (!entry) {
      entry = {
        headerId: g.id,
        // Kept in the same headerRaw shape the rest of this file
        // already expects (see the old text-heuristic path below),
        // so buildImportPlan/commitImportPlan/runIntegrityCheck don't
        // need two separate code paths downstream of this function.
        headerRaw: {
          id: g.id,
          question: g.title || g.instructions || "",
          passageText: g.passageText || "",
          // This schema's OWN groups[] entries never carry a shared image
          // (imageUrl isn't even a field here) — starts null and is filled
          // in just below, IF this group turns out to have a header-shaped
          // pseudo-question among its children carrying the real one.
          imageUrl: null,
          audioUrl: g.audioUrl || "",
        },
        groupType: g.type || null,
        sectionTitle: null, // resolved below, once all children are collected
        firstIndex: index, // this question's position — used to order sections by first appearance, same as any standalone item
        children: [],
        fromSourceGroup: true,
      };
      groupsByOrder.set(g.id, entry);
      passageGroups.push(entry);
    }
    entry.children.push(raw);
  });

  // Pull any header/instructional pseudo-question out of each group's
  // children before it can reach the validator as a "real" question.
  // The sibling project's authoring tool has no group-level passage-
  // image field, so this pattern has repeatedly shown up: a fake first
  // "question" — zero options, no correct answer, an "answer the
  // following N questions" sentence — that is actually just carrying
  // the group's real passage image (confirmed across every affected
  // group so far: the header record's own imageUrl IS the scanned
  // reading passage). Left in as a child, it both inflates the group's
  // question count past the 5-question cap and can never pass
  // validation itself (0 options can never satisfy the 3-4-option
  // rule). Detected via the same detectPassageHeaderCount() the older
  // text-heuristic path (detectGroups) already uses, so both import
  // paths share one definition of "what counts as a header" rather
  // than silently drifting apart.
  passageGroups.forEach((entry) => {
    const headerIndex = entry.children.findIndex((c) => detectPassageHeaderCount(c) !== null);
    if (headerIndex === -1) return;
    const [headerChild] = entry.children.splice(headerIndex, 1);
    if (!entry.headerRaw.question) entry.headerRaw.question = headerChild.question || "";
    if (!entry.headerRaw.imageUrl) entry.headerRaw.imageUrl = headerChild.imageUrl || null;
    if (!entry.headerRaw.audioUrl) entry.headerRaw.audioUrl = headerChild.audioUrl || "";
  });

  // Resolve each group's section title: prefer whatever exact label the
  // majority of its children carry (VERBATIM — this is real content
  // from the source, not a guess), then fall back to a label derived
  // from the group's own `type` only if no child has a section string
  // at all ("general" has no fixed section — e.g. a shared-
  // instructions-only Grammar/Vocabulary block with no better signal).
  passageGroups.forEach((entry) => {
    const fromChildren = majoritySectionLabel(entry.children);
    if (fromChildren) { entry.sectionTitle = fromChildren; return; }
    if (entry.groupType === "listening") { entry.sectionTitle = "Listening"; return; }
    if (entry.groupType === "reading") { entry.sectionTitle = "Reading"; return; }
    entry.sectionTitle = "Reading"; // least-surprising default for a passage-style group with no other signal
  });

  return { passageGroups, standaloneItems, warnings };
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

  // Ordered, title-keyed section builder — sections come into existence
  // in the order their title is first seen while walking the source
  // file's own question order, and are keyed by the EXACT title string
  // (so "Reading" and "reading" would be different sections — this
  // matches "keep it exactly as the source project has it" rather than
  // silently merging near-duplicates, which could hide a genuine
  // labeling inconsistency in the source data instead of surfacing it).
  const sectionOrder = [];
  const bySection = new Map(); // title -> entries[]
  function pushToSection(title, entry) {
    if (!bySection.has(title)) { bySection.set(title, []); sectionOrder.push(title); }
    bySection.get(title).push(entry);
  }

  const ambiguous = [];
  let passageGroups = [];
  let warnings = [];

  const sourceGroups = detectGroupsFromSource(test);

  // Combine groups + standalone items into one list, each carrying its
  // first-appearance index in the source questions[] array, so sections
  // get created in true source order regardless of whether an item is
  // a group (resolved in a second pass, after all its children are
  // known) or a standalone question (resolved immediately).
  const orderedTopLevel = [];

  if (sourceGroups) {
    // Real groups[] + questionGroupId data present — use it directly,
    // no text-pattern guessing needed for these questions at all.
    passageGroups = sourceGroups.passageGroups;
    warnings = sourceGroups.warnings;
    passageGroups.forEach((g) => {
      orderedTopLevel.push({ firstIndex: g.firstIndex, title: g.sectionTitle, kind: "group", group: g });
    });
    // Standalone (non-grouped) questions still go through the normal
    // per-question classification (source `section` field first, see
    // strongSignal, then content heuristics as a last resort).
    const classifications = classifySections(sourceGroups.standaloneItems);
    sourceGroups.standaloneItems.forEach((item, idx) => {
      const [title, confidence] = classifications[idx];
      if (confidence === "low") {
        ambiguous.push({ id: item.raw.id, question: item.raw.question, assignedSection: title, kind: item.kind });
      }
      orderedTopLevel.push({ firstIndex: item.index, title, kind: "standalone", raw: item.raw });
    });
  } else {
    // No groups[] in this file — fall back to the older text-heuristic
    // (still needed for exports made before groups[] was added). No
    // original section names exist for header/child items in this
    // path (they were never real questions with a `section` field to
    // begin with), so these get the same human-readable fallback
    // titles classifySections already uses for content with no signal.
    const { items, warnings: detectWarnings } = detectGroups(test.questions);
    warnings = detectWarnings;
    const classifications = classifySections(items);
    let currentGroup = null;

    items.forEach((item, idx) => {
      const [title, confidence] = classifications[idx];
      if (confidence === "low") {
        ambiguous.push({ id: item.raw.id, question: item.raw.question, assignedSection: title, kind: item.kind });
      }
      if (item.kind === "header") {
        currentGroup = { headerId: item.raw.id, headerRaw: item.raw, declaredCount: item.declaredCount, childCount: item.childCount, sectionTitle: title, firstIndex: item.index, children: [], fromSourceGroup: false };
        passageGroups.push(currentGroup);
        orderedTopLevel.push({ firstIndex: item.index, title, kind: "group", group: currentGroup });
        return;
      }
      if (item.kind === "child") {
        if (currentGroup && currentGroup.headerId === item.headerId) currentGroup.children.push(item.raw);
        return; // children are represented via their parent group entry above, not a separate top-level item
      }
      orderedTopLevel.push({ firstIndex: item.index, title, kind: "standalone", raw: item.raw });
    });
  }

  // Now that every item's title AND source position is known, sort by
  // position and file each into its section — this is what actually
  // creates sections in original source order.
  orderedTopLevel.sort((a, b) => a.firstIndex - b.firstIndex);
  orderedTopLevel.forEach((item) => {
    if (item.kind === "group") pushToSection(item.title, { kind: "group", group: item.group });
    else pushToSection(item.title, { kind: "standalone", raw: item.raw });
  });

  // Duplicate-ID-against-existing-bank check (read-only).
  const allRealQuestions = [];
  passageGroups.forEach((g) => g.children.forEach((c) => allRealQuestions.push(c)));
  bySection.forEach((entries) =>
    entries.forEach((e) => { if (e.kind === "standalone") allRealQuestions.push(e.raw); })
  );
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
    // Dynamic now — one entry per ACTUAL section title found in this
    // file, in source order, instead of always exactly the 4 fixed
    // keys (which silently reported 0 for any section this file didn't
    // happen to use, and had nowhere to put a section this file DID
    // use that wasn't one of those 4).
    perSection: sectionOrder.map((title) => ({
      title,
      count: bySection.get(title).reduce((sum, it) => sum + (it.kind === "group" ? it.group.children.length : 1), 0),
    })),
  };

  // Flag (not silently resolve) any passage-group child that carries its
  // OWN imageUrl distinct from the group's shared one — this project's
  // schema has exactly one imageUrl slot per group, shared by every
  // child, so a child's own separate image has nowhere lossless to go.
  // Skipped entirely for real source groups (g.fromSourceGroup) — that
  // schema's groups[] entries have no shared-image field of their own
  // (the one exception, a header-shaped pseudo-question's image, is
  // already extracted into headerRaw.imageUrl by detectGroupsFromSource
  // before this check runs, so it's never among g.children by the time
  // we get here), so every remaining child's own imageUrl is simply
  // correct as-is, not a conflict with anything.
  const imageConflicts = [];
  passageGroups.forEach((g) => {
    if (g.fromSourceGroup) return;
    g.children.forEach((c) => {
      if (c.imageUrl && c.imageUrl !== g.headerRaw.imageUrl) {
        imageConflicts.push({ groupHeaderId: g.headerId, questionId: c.id, question: c.question, ownImageUrl: c.imageUrl, groupImageUrl: g.headerRaw.imageUrl });
      }
    });
  });

  return {
    valid: true,
    sourceTest: test,
    sectionOrder,
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
    const existing = getBankEntry(raw.id);
    const collision = !!existing;
    let bankId = raw.id;
    if (collision) {
      if (duplicateResolution === "create-copy") {
        bankId = generateId("bq");
      } else {
        // "use-existing": never overwrite anything the admin may have
        // hand-edited — but DO fill in fields that are still genuinely
        // empty on the existing entry when the source has a value for
        // them. Without this, a question first imported before
        // imageUrl/audioUrl were captured at all (see the fix above/
        // this file's own history) stays permanently empty on every
        // future re-import too, even of a corrected source file —
        // "use existing" was skipping the write entirely, which
        // protects real edits but also silently re-loses data that
        // was never there to protect in the first place.
        const gapFill = {};
        if (!existing.imageUrl && raw.imageUrl) gapFill.imageUrl = raw.imageUrl;
        if (!existing.audioUrl && raw.audioUrl) gapFill.audioUrl = raw.audioUrl;
        if (Object.keys(gapFill).length > 0) {
          saveBankEntry({ ...existing, ...gapFill }, { touchModified: false });
        }
      }
      // "use-existing", no gaps to fill: keep raw.id, existing entry untouched.
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
          // Previously omitted here entirely — every imported
          // question's own image/audio was silently dropped, not just
          // ones inside a passage group with its own separate image
          // (see the imageConflicts check above, which only covers
          // that one case, not the general one fixed here).
          imageUrl: raw.imageUrl || null,
          audioUrl: raw.audioUrl || null,
        }),
        { touchModified: false }
      );
    }
    idRemap.set(raw.id, bankId);
    return { id: bankId };
  }

  const usedSectionIds = new Set();
  const sections = plan.sectionOrder.map((title) => {
    const entries = plan.bySection.get(title);
    const groups = entries.map((entry) => {
      if (entry.kind === "group") {
        const g = entry.group;
        return {
          id: g.headerId,
          type: "passage_group",
          title: g.headerRaw.question || "",
          // Previously hardcoded to "" unconditionally — silently
          // dropped every passage's actual text on import even when
          // the source had it. Now carried through from the source
          // group (see detectGroupsFromSource) when present.
          passageText: g.headerRaw.passageText || "",
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
    // id is a slug of the VERBATIM title, not a hardcoded key — two
    // different source files can now genuinely have different section
    // sets/names/counts/order, and each gets its own faithful id/title
    // pair instead of being forced into one of 4 fixed slots. Guarded
    // against two different titles happening to slugify to the same
    // string (e.g. "Reading!" / "Reading?") — titles themselves stay
    // exactly as-is either way, only the internal id gets disambiguated.
    let id = `sec-${slugify(title)}`;
    let n = 2;
    while (usedSectionIds.has(id)) { id = `sec-${slugify(title)}-${n}`; n += 1; }
    usedSectionIds.add(id);
    return { id, title, groups };
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
  plan.bySection.forEach((entries) =>
    entries.forEach((e) => { if (e.kind === "standalone") sourceRealQuestions.push(e.raw); })
  );

  sourceRealQuestions.forEach((src) => {
    const bankId = idRemap.get(src.id) || src.id;
    const entry = getBankEntry(bankId);
    if (!entry) { mismatches.push({ id: src.id, field: "(entire question)", reason: "missing from bank after import" }); return; }
    const fields = ["question", "correctOption", "explanation", "marks", "imageUrl", "audioUrl"];
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
