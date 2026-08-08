/**
 * questionBank.js
 * The master Question Bank: every question lives here exactly once,
 * keyed by id. Test drafts (see editor.js) store references — plain
 * `{ id }` stubs pointing into this bank — inside their groups, not
 * copies of the question data. Editing a bank entry therefore updates
 * it everywhere it's referenced, which is the actual point of a
 * question bank (matches Moodle's Question Bank semantics, not a
 * per-test question list).
 *
 * Storage: one flat object in localStorage, { [questionId]: entry }.
 * This is intentionally a SEPARATE store from admin/js/storage.js's
 * per-draft records — the bank is not owned by any one test.
 */

const BANK_KEY = "nmt_admin_question_bank_v1";

/** Full bank entry shape (all the fields the spec's Question Bank asks for). */
export function newBankEntry(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || generateBankId(),
    question: "",
    options: ["", "", "", ""],
    correctOption: null,
    explanation: "",
    marks: 1,
    difficulty: "medium", // "easy" | "medium" | "hard"
    jlptLevel: null, // "N5".."N1" | null
    category: null, // "Scripts & Vocabulary" | "Conversation & Expression" | "Listening" | "Reading" | null
    tags: [],
    imageUrl: null,
    audioUrl: null,
    createdAt: now,
    modifiedAt: now,
    status: "active", // "active" | "archived"
    bookmarked: false,
    favorite: false,
    required: false,
    ...overrides,
  };
}

/**
 * Richer than computeUsageCounts: for each bank id, also tracks which
 * group TYPES and SECTION titles it's actually used under across every
 * draft. A bank question has no inherent "type" of its own (the same
 * question could theoretically be used standalone in one test and inside
 * a passage group in another) — the Question Bank page's Type/Section
 * filters are answered from actual usage, not a stored property.
 */
export function computeUsageDetails() {
  const details = {}; // id -> { count, groupTypes: Set, sectionTitles: Set, testTitles: Set }
  const ensure = (id) => {
    if (!details[id]) details[id] = { count: 0, groupTypes: new Set(), sectionTitles: new Set(), testTitles: new Set() };
    return details[id];
  };

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("nmt_admin_draft_")) continue;
    try {
      const draft = JSON.parse(localStorage.getItem(key));
      (draft.sections || []).forEach((section) => {
        (section.groups || []).forEach((group) => {
          (group.questions || []).forEach((ref) => {
            if (!ref || !ref.id) return;
            const d = ensure(ref.id);
            d.count += 1;
            d.groupTypes.add(group.type);
            d.sectionTitles.add(section.title);
            if (draft.title) d.testTitles.add(draft.title);
          });
        });
      });
    } catch (err) {
      // Skip anything that doesn't parse.
    }
  }
  return details;
}

function generateBankId() {
  return `bq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readBank() {
  try {
    const raw = localStorage.getItem(BANK_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("questionBank.readBank failed", err);
    return {};
  }
}

function writeBank(bank) {
  try {
    localStorage.setItem(BANK_KEY, JSON.stringify(bank));
    return true;
  } catch (err) {
    console.error("questionBank.writeBank failed", err);
    return false;
  }
}

/** All bank entries as an array (most-recently-modified first). */
export function listBankEntries() {
  const bank = readBank();
  return Object.values(bank).sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

export function getBankEntry(id) {
  const bank = readBank();
  return bank[id] || null;
}

/** Create (or overwrite-by-id) a bank entry. Bumps modifiedAt automatically unless explicitly suppressed. */
export function saveBankEntry(entry, { touchModified = true } = {}) {
  const bank = readBank();
  const existing = bank[entry.id];
  bank[entry.id] = {
    ...(existing || newBankEntry({ id: entry.id })),
    ...entry,
    modifiedAt: touchModified ? new Date().toISOString() : entry.modifiedAt || existing?.modifiedAt,
  };
  writeBank(bank);
  return bank[entry.id];
}

/** Permanently remove a bank entry. Callers are responsible for checking usage first (see computeUsageCounts). */
export function deleteBankEntry(id) {
  const bank = readBank();
  delete bank[id];
  writeBank(bank);
}

/**
 * Count how many (draft, group) slots reference each bank id, across
 * EVERY test draft — not just the one currently open. Needed for the
 * "Usage Count" field, the "Unused Questions" / "Frequently Used"
 * filters, and to warn before deleting a question that's still in use.
 * Reads admin/js/storage.js's own localStorage keys directly (a plain
 * prefix scan) to avoid a circular import between the two modules.
 */
export function computeUsageCounts() {
  const counts = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("nmt_admin_draft_")) continue;
    try {
      const draft = JSON.parse(localStorage.getItem(key));
      (draft.sections || []).forEach((section) => {
        (section.groups || []).forEach((group) => {
          (group.questions || []).forEach((ref) => {
            if (ref && ref.id) counts[ref.id] = (counts[ref.id] || 0) + 1;
          });
        });
      });
    } catch (err) {
      // Skip any draft record that doesn't parse — not this function's job to repair it.
    }
  }
  return counts;
}

/** Resolve a group's question REFERENCES into full bank entries — for feeding groupRenderer.js (which expects real question objects), not for storing back into a draft. */
export function resolveGroupQuestions(group) {
  return {
    ...group,
    questions: (group.questions || []).map((ref) => getBankEntry(ref.id) || newBankEntry({ id: ref.id, question: "[Missing question — its bank entry was deleted]" })),
  };
}

/** Import (find-and-reuse if already present) a fully-embedded legacy question object into the bank, returning its bank id. */
export function importQuestionIntoBank(rawQuestion) {
  const bank = readBank();
  // Reuse an existing entry with the same id if one's already there (keeps re-imports idempotent).
  if (rawQuestion.id && bank[rawQuestion.id]) {
    return rawQuestion.id;
  }
  const entry = newBankEntry({
    id: rawQuestion.id || generateBankId(),
    question: rawQuestion.question || "",
    options: Array.isArray(rawQuestion.options) ? rawQuestion.options : ["", "", "", ""],
    correctOption: rawQuestion.correctOption ?? null,
    explanation: rawQuestion.explanation || "",
    marks: typeof rawQuestion.marks === "number" ? rawQuestion.marks : 1,
    tags: Array.isArray(rawQuestion.tags) ? rawQuestion.tags : [],
    difficulty: rawQuestion.difficulty || "medium",
  });
  bank[entry.id] = entry;
  writeBank(bank);
  return entry.id;
}
