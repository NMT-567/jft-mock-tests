/**
 * validator.js
 * Validates a test draft (sections -> groups -> questions) before export.
 * Returns a flat list of { sectionId, groupId, childIndex, field, message }
 * errors — empty array means the draft is export-ready.
 *
 * SINCE THE QUESTION BANK CHANGE: `group.questions` holds bare references
 * (`{ id }`) into the master bank, not embedded question data — every
 * check here resolves the reference first via getBankEntry(). A
 * reference whose bank entry no longer exists is now its own error
 * ("broken reference") rather than silently validating an empty object.
 */
import { getBankEntry } from "./questionBank.js?v=4";

/** True if a question has everything required to export cleanly (used by both the full validator and the editor's "Incomplete" filter). Takes a RESOLVED bank entry, not a reference. Accepts 3 OR 4 filled options — this JFT dataset legitimately has both; see validateQuestionFields() below for the matching rule. */
export function isQuestionComplete(q) {
  if (!q || !q.question || !q.question.trim()) return false;
  const filledOptions = (q.options || []).filter((o) => o && o.trim());
  if (filledOptions.length < 3 || filledOptions.length > 4) return false;
  if (!q.correctOption || !q.correctOption.trim() || !filledOptions.includes(q.correctOption)) return false;
  if (typeof q.marks !== "number" || Number.isNaN(q.marks) || q.marks <= 0) return false;
  return true;
}

function validateQuestionFields(q, label, errors, loc) {
  if (!q.question || !q.question.trim()) {
    errors.push({ ...loc, field: "question", message: `${label}: question text is required.` });
  }

  // Accept 3 OR 4 filled options, never fewer or more — this JFT dataset
  // legitimately mixes both across Scripts & Vocabulary, Conversation &
  // Expression, Listening, and Reading, so requiring exactly 4 was a
  // validator bug, not a real content rule. 0-2 and 5+ remain rejected.
  const filledOptions = (q.options || []).filter((o) => o && o.trim());
  const hasValidOptionCount = filledOptions.length === 3 || filledOptions.length === 4;
  if (!hasValidOptionCount) {
    errors.push({ ...loc, field: "options", message: `${label}: 3 or 4 options are required (found ${filledOptions.length}).` });
  }

  if (!q.correctOption || !q.correctOption.trim()) {
    errors.push({ ...loc, field: "correctOption", message: `${label}: a correct answer must be selected.` });
  } else if (hasValidOptionCount && !filledOptions.includes(q.correctOption)) {
    errors.push({ ...loc, field: "correctOption", message: `${label}: the correct answer must match one of the options.` });
  }

  if (typeof q.marks !== "number" || Number.isNaN(q.marks) || q.marks <= 0) {
    errors.push({ ...loc, field: "marks", message: `${label}: marks must be a positive number.` });
  }
}

const GROUP_TYPE_LABELS = {
  single: "Question",
  passage_group: "Passage Group",
  conversation_group: "Conversation Group",
  listening_group: "Listening Group",
  image_group: "Image Group",
};

function validateGroup(group, section, errors) {
  const firstResolved = group.questions?.[0] ? getBankEntry(group.questions[0].id) : null;
  const label = `${GROUP_TYPE_LABELS[group.type] || "Group"} "${group.title || firstResolved?.question?.slice(0, 24) || "Untitled"}" (Section "${section.title}")`;
  const loc = { sectionId: section.id, groupId: group.id };

  // A Reading passage may legitimately be represented by an image/scan
  // instead of (or in addition to) typed passage text — group.imageUrl
  // already renders for every group type via the shared media block in
  // js/groupRenderer.js (not gated to passage_group specifically), so
  // this was purely a validator gap, not a missing feature: the content
  // and rendering already fully support an image-only passage.
  const hasPassageText = group.passageText && group.passageText.trim();
  const hasPassageImage = group.imageUrl && group.imageUrl.trim();
  if (group.type === "passage_group" && !hasPassageText && !hasPassageImage) {
    errors.push({ ...loc, field: "passageText", message: `${label}: passage text or a passage image is required.` });
  }
  if (group.type === "conversation_group") {
    if (!group.speakerAText || !group.speakerAText.trim()) {
      errors.push({ ...loc, field: "speakerAText", message: `${label}: Speaker A dialogue is required.` });
    }
    if (!group.speakerBText || !group.speakerBText.trim()) {
      errors.push({ ...loc, field: "speakerBText", message: `${label}: Speaker B dialogue is required.` });
    }
    if (!group.audioUrl) {
      errors.push({ ...loc, field: "audioUrl", message: `${label}: conversation audio is required.` });
    }
  }
  if (group.type === "listening_group" && !group.audioUrl) {
    errors.push({ ...loc, field: "audioUrl", message: `${label}: listening audio is required.` });
  }
  if (group.type === "image_group" && !group.imageUrl) {
    errors.push({ ...loc, field: "imageUrl", message: `${label}: an image is required.` });
  }

  const minQuestions = group.type === "single" ? 1 : 2;
  if (!group.questions || group.questions.length < minQuestions) {
    errors.push({ ...loc, field: "questions", message: `${label}: needs at least ${minQuestions} question${minQuestions === 1 ? "" : "s"}.` });
  }
  if (group.type !== "single" && group.questions && group.questions.length > 5) {
    errors.push({ ...loc, field: "questions", message: `${label}: supports at most 5 questions.` });
  }

  (group.questions || []).forEach((ref, idx) => {
    const entry = getBankEntry(ref.id);
    if (!entry) {
      errors.push({ ...loc, childIndex: idx, field: "reference", message: `${label} — Question ${idx + 1}: this references bank question "${ref.id}", which no longer exists (broken reference). Remove it or restore the bank entry.` });
      return;
    }
    validateQuestionFields(entry, `${label} — Question ${idx + 1}`, errors, { ...loc, childIndex: idx });
  });
}

function collectStructuralIds(draft) {
  const ids = [];
  (draft.sections || []).forEach((section) => {
    ids.push({ id: section.id, kind: "section" });
    (section.groups || []).forEach((group) => {
      ids.push({ id: group.id, kind: "group" });
      // Question ids are intentionally excluded here: the same bank
      // question appearing in multiple groups is a REFERENCE, not a
      // duplicate — that's the entire point of a shared question bank.
    });
  });
  return ids;
}

function validateNoDuplicateIds(draft, errors) {
  const seen = new Map();
  collectStructuralIds(draft).forEach(({ id, kind }) => {
    if (!id) return;
    const count = (seen.get(id) || 0) + 1;
    seen.set(id, count);
    if (count === 2) {
      errors.push({ sectionId: null, field: "id", message: `Duplicate ${kind} id "${id}" appears more than once — this can corrupt scoring on the student site.` });
    }
  });
}

export function validateDraft(draft) {
  const errors = [];

  if (!draft.title || !draft.title.trim()) {
    errors.push({ sectionId: null, field: "title", message: "Test name is required." });
  }
  if (!draft.noTimeLimit && (typeof draft.duration !== "number" || draft.duration <= 0)) {
    errors.push({ sectionId: null, field: "duration", message: "Duration must be a positive number of minutes (or enable No Time Limit)." });
  }
  if (typeof draft.passMarks !== "number" || draft.passMarks <= 0) {
    errors.push({ sectionId: null, field: "passMarks", message: "Passing marks must be a positive number." });
  }

  const sections = Array.isArray(draft.sections) ? draft.sections : [];
  if (sections.length === 0) {
    errors.push({ sectionId: null, field: "sections", message: "The test has no sections yet." });
  }

  sections.forEach((section) => {
    if (!section.title || !section.title.trim()) {
      errors.push({ sectionId: section.id, field: "title", message: "Every section needs a title." });
    }
    if (!section.groups || section.groups.length === 0) {
      errors.push({ sectionId: section.id, field: "groups", message: `Section "${section.title || "Untitled"}" has no questions yet.` });
    }
    (section.groups || []).forEach((group) => validateGroup(group, section, errors));
  });

  validateNoDuplicateIds(draft, errors);

  return errors;
}

export function isDraftValid(draft) {
  return validateDraft(draft).length === 0;
}

/**
 * Best-effort "no broken images/audio" check. Only meaningful for network
 * URLs — data: URLs (the default for uploads in this admin, see
 * components.js's readFileAsDataUrl) are embedded bytes and will always
 * "load" instantly, so this mainly catches stale/incorrect external URLs.
 * A slow-but-valid URL is NOT reported as broken (see TIMEOUT_MS) — this
 * checks reachability within a reasonable window, not a guarantee.
 */
const MEDIA_CHECK_TIMEOUT_MS = 4000;

function probeUrl(url, kind) {
  return new Promise((resolve) => {
    const el = document.createElement(kind === "audio" ? "audio" : "img");
    const timer = setTimeout(() => resolve({ url, kind, ok: true, reason: "timeout-assumed-ok" }), MEDIA_CHECK_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timer);
    if (kind === "audio") {
      el.addEventListener("loadedmetadata", () => { cleanup(); resolve({ url, kind, ok: true }); }, { once: true });
    } else {
      el.addEventListener("load", () => { cleanup(); resolve({ url, kind, ok: true }); }, { once: true });
    }
    el.addEventListener("error", () => { cleanup(); resolve({ url, kind, ok: false }); }, { once: true });
    el.src = url;
  });
}

/** Check every unique group-level imageUrl/audioUrl for reachability. Returns failures only. */
export async function checkBrokenMedia(draft) {
  const seen = new Map(); // url -> kind
  (draft.sections || []).forEach((section) => {
    (section.groups || []).forEach((group) => {
      if (group.imageUrl && !group.imageUrl.startsWith("data:")) seen.set(group.imageUrl, "image");
      if (group.audioUrl && !group.audioUrl.startsWith("data:")) seen.set(group.audioUrl, "audio");
    });
  });

  const results = await Promise.all([...seen.entries()].map(([url, kind]) => probeUrl(url, kind)));
  return results.filter((r) => !r.ok);
}
