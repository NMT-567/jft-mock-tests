/**
 * import.js
 * Loads an exported test JSON into the admin's internal draft shape.
 * Handles three cases:
 *   1. Current v2 files (top-level `sections[]`) — straight field mapping.
 *      An empty `sections: []` is a valid (if empty) file, not an error.
 *   2. Legacy v1 files (top-level `tests: [{ questions: [...] }]`, from
 *      before the sections/groups schema existed) — the first test's
 *      questions are reconstructed into groups using their `groupId`/
 *      `groupType`/`groupTitle` round-trip metadata when present (the old
 *      admin wrote these), or treated as standalone single questions
 *      otherwise. Everything lands in one default section.
 *   3. Anything else — a specific error naming what WAS found, not a
 *      generic "doesn't look compatible" message.
 *
 * SINCE THE QUESTION BANK CHANGE: every imported question is registered
 * in the master Question Bank (admin/js/questionBank.js) — re-imports of
 * the same file reuse the existing bank entry by id rather than creating
 * duplicates — and the draft stores only a `{ id }` reference to it, not
 * the full question data.
 */
import { generateId } from "./components.js?v=3";
import { importQuestionIntoBank } from "./questionBank.js?v=4";

/* =========================================================
   V2 IMPORT (current schema)
   ========================================================= */
function importQuestion(raw) {
  const options = Array.isArray(raw.options) ? [...raw.options] : [];
  while (options.length < 4) options.push("");
  const bankId = importQuestionIntoBank({
    id: raw.id || generateId("q"),
    question: raw.question || "",
    options: options.slice(0, 4),
    correctOption: raw.correctOption ?? null,
    explanation: raw.explanation || "",
    marks: typeof raw.marks === "number" ? raw.marks : 1,
  });
  return { id: bankId };
}

function importGroup(raw) {
  const type = raw.type || "single";
  return {
    id: raw.id || generateId("group"),
    type,
    title: raw.title || "",
    passageText: type === "passage_group" ? raw.passageText || "" : undefined,
    speakerAName: type === "conversation_group" ? raw.speakerAName || "Speaker A" : undefined,
    speakerAText: type === "conversation_group" ? raw.speakerAText || "" : undefined,
    speakerBName: type === "conversation_group" ? raw.speakerBName || "Speaker B" : undefined,
    speakerBText: type === "conversation_group" ? raw.speakerBText || "" : undefined,
    imageUrl: raw.imageUrl || null,
    audioUrl: raw.audioUrl || null,
    questions: Array.isArray(raw.questions) ? raw.questions.map(importQuestion) : [],
  };
}

function importSection(raw) {
  return {
    id: raw.id || generateId("section"),
    title: raw.title || "Untitled Section",
    groups: Array.isArray(raw.groups) ? raw.groups.map(importGroup) : [],
  };
}

function draftShellFrom(raw) {
  return {
    id: raw.id || generateId("test"),
    title: raw.title || "Imported Test",
    categoryName: raw.categoryName || raw.categoryId || "General",
    topic: raw.topic || "",
    description: raw.description || "",
    language: raw.language || "en",
    duration: typeof raw.duration === "number" ? raw.duration : 60,
    noTimeLimit: !!raw.noTimeLimit,
    passMarks: typeof raw.passMarks === "number" ? raw.passMarks : null,
    active: raw.active !== false,
    premium: !!raw.premium,
    createdAt: raw.createdAt || new Date().toISOString(),
  };
}

/** Convert a raw v2 export document into the admin's draft shape. */
export function importDocumentToDraft(raw) {
  return {
    ...draftShellFrom(raw),
    sections: Array.isArray(raw.sections) ? raw.sections.map(importSection) : [],
  };
}

/* =========================================================
   V1 IMPORT (legacy — pre-sections/groups schema)
   v1 shape: { tests: [{ ...testFields, questions: [{ ..., groupId?,
   groupType?, groupTitle?, passage? }] }] }
   ========================================================= */
export function importLegacyV1Test(rawTest) {
  const rawQuestions = Array.isArray(rawTest.questions) ? rawTest.questions : [];
  const groups = [];
  const groupsById = new Map();

  rawQuestions.forEach((raw) => {
    const bankId = importQuestionIntoBank({
      id: raw.id || generateId("q"),
      question: raw.question || "",
      options: Array.isArray(raw.options) ? raw.options.slice(0, 4) : ["", "", "", ""],
      correctOption: raw.correctOption ?? null,
      explanation: raw.explanation || "",
      marks: typeof raw.marks === "number" ? raw.marks : 1,
    });
    const reference = { id: bankId };

    if (raw.groupId && raw.groupType) {
      // Old admin's round-trip metadata — reconstruct the real group.
      let group = groupsById.get(raw.groupId);
      if (!group) {
        const type = raw.groupType === "conversationGroup" || raw.groupType === "conversation_group" ? "conversation_group" : "passage_group";
        group = { id: raw.groupId, type, title: raw.groupTitle || "", imageUrl: raw.imageUrl || null, audioUrl: raw.audioUrl || null, questions: [] };
        if (type === "passage_group") {
          group.passageText = raw.passage || "";
        } else {
          const [a, b] = splitConversationPassage(raw.passage);
          group.speakerAName = a.name;
          group.speakerAText = a.text;
          group.speakerBName = b.name;
          group.speakerBText = b.text;
        }
        groupsById.set(raw.groupId, group);
        groups.push(group);
      }
      group.questions.push(reference);
      return;
    }

    // No group metadata — standalone single question. Any leftover
    // `passage` text (a flat single question could carry one) is dropped
    // since the current "single" group type has no passage field — this
    // is the one known lossy edge in legacy import.
    groups.push({
      id: generateId("group"),
      type: "single",
      title: "",
      imageUrl: raw.imageUrl || null,
      audioUrl: raw.audioUrl || null,
      questions: [reference],
    });
  });

  return {
    ...draftShellFrom(rawTest),
    sections: [{ id: generateId("section"), title: "Section 1", groups }],
  };
}

function splitConversationPassage(passage) {
  const fallback = [{ name: "Speaker A", text: "" }, { name: "Speaker B", text: "" }];
  if (!passage) return fallback;
  const parts = passage.split(/\n\n+/);
  const parse = (part, defaultName) => {
    const match = /^(.*?):\s*([\s\S]*)$/.exec(part || "");
    return match ? { name: match[1].trim(), text: match[2].trim() } : { name: defaultName, text: part || "" };
  };
  return [parse(parts[0], "Speaker A"), parse(parts[1], "Speaker B")];
}

/* =========================================================
   FILE ENTRY POINT
   ========================================================= */

/** Parse a File (from an <input type="file"> or drop) into a draft, or throw a descriptive error. */
export async function importFileToDraft(file) {
  const text = await file.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error("That file isn't valid JSON.");
  }

  if (Array.isArray(json.sections)) {
    // A legitimately empty sections[] is still a valid (if empty) file — not an error.
    return importDocumentToDraft(json);
  }

  if (Array.isArray(json.tests)) {
    if (json.tests.length === 0) {
      throw new Error("This file's tests[] array is empty — there's nothing to import.");
    }
    return importLegacyV1Test(json.tests[0]);
  }

  const foundKeys = Object.keys(json).slice(0, 6).join(", ") || "(empty object)";
  throw new Error(`This file has neither a sections[] nor a tests[] array — found: ${foundKeys}. It doesn't look like a Selected_Mock_Tests.json export.`);
}
