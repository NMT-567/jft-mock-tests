/**
 * export.js
 * Converts an admin draft into the exact v2 JSON schema js/loader.js
 * expects on the student site.
 *
 * COMPATIBILITY CONTRACT — read before changing field names:
 * loader.js's normalizeTest()/normalizeGroup()/normalizeQuestion() only
 * ever read these fields:
 *   top level: id, title, categoryName, topic, duration, noTimeLimit,
 *              passMarks, sections
 *   section:   id, title, groups
 *   group:     id, type, title, passageText, speakerAName, speakerAText,
 *              speakerBName, speakerBText, imageUrl, audioUrl, questions
 *   question:  id, question, options, correctOption, explanation, marks
 * Any other field (description, language, active, premium, createdAt) is
 * simply ignored by the student site. Never rename/remove a field in the
 * list above without also updating js/loader.js.
 *
 * SINCE THE QUESTION BANK CHANGE: a draft's `group.questions` now holds
 * bare REFERENCES (`{ id }`) into the master Question Bank, not full
 * question data — see admin/js/questionBank.js. This file is the one
 * place those references get resolved back into fully-embedded question
 * objects, because the exported JSON must remain self-contained (the
 * static student site has no bank to look anything up in). A reference
 * whose bank entry has been deleted exports as an empty placeholder
 * question rather than being silently dropped, so the question count
 * students see always matches what the admin built.
 */
import { getBankEntry } from "./questionBank.js?v=4";

function buildExportQuestion(ref) {
  const entry = getBankEntry(ref.id) || { id: ref.id, question: "", options: [], correctOption: null, explanation: "", marks: 1 };
  return {
    id: entry.id,
    question: entry.question || "",
    options: (entry.options || []).filter((o) => o !== null && o !== undefined),
    correctOption: entry.correctOption ?? null,
    explanation: entry.explanation || "",
    marks: typeof entry.marks === "number" ? entry.marks : 1,
    required: !!entry.required,
  };
}

function buildExportGroup(group) {
  return {
    id: group.id,
    type: group.type,
    title: group.title || "",
    passageText: group.type === "passage_group" ? group.passageText || "" : undefined,
    speakerAName: group.type === "conversation_group" ? group.speakerAName || "Speaker A" : undefined,
    speakerAText: group.type === "conversation_group" ? group.speakerAText || "" : undefined,
    speakerBName: group.type === "conversation_group" ? group.speakerBName || "Speaker B" : undefined,
    speakerBText: group.type === "conversation_group" ? group.speakerBText || "" : undefined,
    imageUrl: group.imageUrl || null,
    audioUrl: group.audioUrl || null,
    questions: (group.questions || []).map(buildExportQuestion),
  };
}

function buildExportSection(section) {
  return {
    id: section.id,
    title: section.title || "Untitled Section",
    groups: (section.groups || []).map(buildExportGroup),
  };
}

/** Build the full v2 export document from a draft. */
export function buildExportDocument(draft) {
  return {
    formatVersion: 2,
    source: "nmt-admin",
    exportedAt: new Date().toISOString(),
    id: draft.id,
    title: draft.title || "Mock Test",
    categoryName: draft.categoryName || "General",
    topic: draft.topic || "",
    description: draft.description || "",
    language: draft.language || "en",
    duration: typeof draft.duration === "number" ? draft.duration : 60,
    noTimeLimit: !!draft.noTimeLimit,
    passMarks: typeof draft.passMarks === "number" ? draft.passMarks : null,
    resultSettings: draft.resultSettings || null,
    securitySettings: draft.securitySettings || null,
    active: draft.active !== false,
    premium: !!draft.premium,
    createdAt: draft.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sections: (draft.sections || []).map(buildExportSection),
  };
}

/** Count every question across every section/group (for validation summaries, dashboard counts). */
export function countDraftQuestions(draft) {
  return (draft.sections || []).reduce(
    (sum, section) => sum + (section.groups || []).reduce((gSum, group) => gSum + (group.questions || []).length, 0),
    0
  );
}

/** Flatten every question across every section/group into one ordered, globally-numbered list — used by the live preview and validator. Resolves bank references so callers get real question data. */
export function flattenDraftQuestions(draft) {
  const flat = [];
  let order = 0;
  (draft.sections || []).forEach((section, sectionIndex) => {
    (section.groups || []).forEach((group) => {
      (group.questions || []).forEach((ref) => {
        const entry = getBankEntry(ref.id) || { id: ref.id, question: "[Missing question]", options: [], correctOption: null, explanation: "", marks: 1 };
        order += 1;
        flat.push({
          order,
          sectionIndex,
          sectionTitle: section.title,
          groupId: group.id,
          groupType: group.type,
          groupTitle: group.title,
          passage: group.type === "passage_group" ? group.passageText : null,
          imageUrl: group.imageUrl || null,
          audioUrl: group.audioUrl || null,
          question: entry.question,
          options: entry.options,
          correctOption: entry.correctOption,
          explanation: entry.explanation,
          marks: entry.marks,
          id: entry.id,
        });
      });
    });
  });
  return flat;
}

/** Trigger a browser download of the export document as Selected_Mock_Tests.json. */
export function downloadExport(draft, filename = "Selected_Mock_Tests.json") {
  const doc = buildExportDocument(draft);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return doc;
}
