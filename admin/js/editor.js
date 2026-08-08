/**
 * editor.js
 * Controller for editor.html — Google-Forms-style document editor with a
 * Google-Photos-style bulk selection mode layered on top.
 *
 * SELECTION MODE: clicking any question's checkbox adds it to
 * `selectedIds` and shows the floating bottom Selection Toolbar (Move/
 * Merge/Convert on it open a centered dialog — no nested dropdowns).
 * Selection state lives independently of rendering (a plain Set), so it
 * survives scrolling and re-renders automatically — every render just
 * reads `selectedIds.has(ref.id)` to decide a card's checked/selected state.
 *
 * REQUIRED (new field): stored on the Question Bank entry as
 * `entry.required`, admin-side only. It is NOT part of the exported
 * schema and has NO effect on the student exam — there is currently no
 * "optional question" concept in the student CBT, and adding one would
 * mean modifying js/exam.js / js/loader.js, which this task explicitly
 * forbids. "Required ON/OFF" here is an organizational/tracking flag
 * only (visible as a badge on the card), not a behavior toggle. This is
 * disclosed here and in the final summary rather than silently no-op'd.
 *
 * QUESTION BANK ARCHITECTURE (unchanged): `group.questions` holds bare
 * REFERENCES (`{ id }`) into the master Question Bank (questionBank.js).
 * The export/import/loader contract is UNCHANGED — export.js resolves
 * references back into fully-embedded question data, so the exported
 * JSON and the student site are unaffected by any of this file's changes.
 */
import { loadDraft, saveDraft, setLastOpenedDraftId } from "./storage.js?v=3";
import { el, generateId, showToast, readFileAsDataUrl, confirmDialog } from "./components.js?v=3";
import { validateDraft, isQuestionComplete, checkBrokenMedia } from "./validator.js?v=6";
import { downloadExport, buildExportDocument } from "./export.js?v=8";
import { renderGroupPreview } from "./preview.js?v=10";
import { hidePageLoader, initThemeToggle, debounce, getQueryParam } from "../../js/utils.js?v=4";
import { newBankEntry, getBankEntry, saveBankEntry, listBankEntries, computeUsageCounts } from "./questionBank.js?v=4";

const GROUP_TYPES = ["passage_group", "conversation_group", "listening_group", "image_group"];
const GROUP_TYPE_LABELS = {
  single: "Question",
  passage_group: "Passage Group",
  conversation_group: "Conversation Group",
  listening_group: "Listening Group",
  image_group: "Image Group",
};
const GROUP_TYPE_ICONS = {
  single: "",
  passage_group: "📖",
  conversation_group: "💬",
  listening_group: "🎧",
  image_group: "🖼",
};
/**
 * The exam ALWAYS contains exactly these 4 sections, in this fixed order.
 * No creating, deleting, renaming, or reordering — every draft's
 * `sections` array is forced to exactly this shape by ensureFixedSections()
 * on load. Estimated-time-per-question below is a documented heuristic
 * for the progress bar, NOT tied to the real per-test timer (that's still
 * the admin's own `duration` field on Test Settings).
 */
const FIXED_SECTIONS = [
  { id: "sec-scripts", title: "Scripts & Vocabulary", icon: "📘" },
  { id: "sec-conversation", title: "Conversation & Expression", icon: "💬" },
  { id: "sec-listening", title: "Listening", icon: "🎧" },
  { id: "sec-reading", title: "Reading", icon: "📖" },
];
const ESTIMATED_MINUTES_PER_QUESTION = 0.75; // heuristic only, see comment above
const MAX_GROUP_QUESTIONS = 5;
const MAX_HISTORY = 2000; // sanity ceiling, not a designed limit
const LONG_PRESS_MS = 500;

/** Mirrors loader.js's DEFAULT_RESULT_SETTINGS exactly — kept as a separate literal here (not imported) since editor.js and loader.js run in different bundles (admin vs student) and this project has no shared-constants module; the two must be kept in sync by hand if either changes. */
const DEFAULT_RESULT_SETTINGS = {
  titleJa: "試験の結果をお知らせします。",
  titleEn: "Your test results are as follows.",
  minScore: 10,
  maxScore: 250,
  passingScore: 200,
  scoreMode: "raw",
  rawMin: 0,
  rawMax: null,
  finalMin: 10,
  finalMax: 250,
  passedJa: "あなたは日本語能力水準に達しました。",
  passedEn: "You were assessed to have reached the required Japanese language proficiency level.",
  failedJa: "あなたは日本語能力水準には達していないと判定されました。",
  failedEn: "You were assessed to have not reached the required Japanese language proficiency level.",
  sectionLabels: {
    "sec-scripts": { ja: "文字と語彙", en: "Script and Vocabulary" },
    "sec-conversation": { ja: "会話と表現", en: "Conversation and Expression" },
    "sec-listening": { ja: "聴解", en: "Listening Comprehension" },
    "sec-reading": { ja: "読解", en: "Reading Comprehension" },
  },
};

/** Mirrors loader.js's DEFAULT_SECURITY_SETTINGS exactly (same hand-sync caveat as DEFAULT_RESULT_SETTINGS above) — every restriction on, 3-violation warning threshold. */
const DEFAULT_SECURITY_SETTINGS = {
  disableTextSelection: true,
  disableCopy: true,
  disableCut: true,
  disablePaste: true,
  disableContextMenu: true,
  disablePrint: true,
  requestFullscreen: true,
  detectFullscreenExit: true,
  detectTabSwitch: true,
  blockShortcuts: true,
  trackSecurityEvents: true,
  maxViolations: 3,
  thresholdAction: "warn",
};

const els = {
  testTitleInput: document.getElementById("testTitleInput"),
  saveStatus: document.getElementById("saveStatus"),
  toolbarDarkModeToggle: document.getElementById("toolbarDarkModeToggle"),
  undoBtn: document.getElementById("undoBtn"),
  redoBtn: document.getElementById("redoBtn"),
  previewFullBtn: document.getElementById("previewFullBtn"),
  exportBtn: document.getElementById("exportBtn"),
  publishBtn: document.getElementById("publishBtn"),

  sidebarSearchInput: document.getElementById("sidebarSearchInput"),
  sidebarToolbarRow: document.getElementById("sidebarToolbarRow"),
  filterChipRow: document.getElementById("filterChipRow"),
  filterMenuBtn: document.getElementById("filterMenuBtn"),
  filterMenu: document.getElementById("filterMenu"),
  settingsNavBtn: document.getElementById("settingsNavBtn"),
  progressBarSections: document.getElementById("progressBarSections"),
  sidebarTree: document.getElementById("sidebarTree"),
  outlineTabBtn: document.getElementById("outlineTabBtn"),
  bankTabBtn: document.getElementById("bankTabBtn"),
  bankPanel: document.getElementById("bankPanel"),
  bankSearchInput: document.getElementById("bankSearchInput"),
  bankPanelList: document.getElementById("bankPanelList"),

  selectPanelBtn: document.getElementById("selectPanelBtn"),
  selectPanel: document.getElementById("selectPanel"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectSectionBtn: document.getElementById("selectSectionBtn"),
  selectGroupBtn: document.getElementById("selectGroupBtn"),
  invertSelectionBtn: document.getElementById("invertSelectionBtn"),
  clearSelectionMenuBtn: document.getElementById("clearSelectionMenuBtn"),

  selectionToolbar: document.getElementById("selectionToolbar"),
  selectionCount: document.getElementById("selectionCount"),
  selRequiredOnBtn: document.getElementById("selRequiredOnBtn"),
  selRequiredOffBtn: document.getElementById("selRequiredOffBtn"),
  selBookmarkBtn: document.getElementById("selBookmarkBtn"),
  selUnbookmarkBtn: document.getElementById("selUnbookmarkBtn"),
  selDuplicateBtn: document.getElementById("selDuplicateBtn"),
  selUngroupBtn: document.getElementById("selUngroupBtn"),
  selMoveBtn: document.getElementById("selMoveBtn"),
  selMergeBtn: document.getElementById("selMergeBtn"),
  selConvertBtn: document.getElementById("selConvertBtn"),
  selDeleteBtn: document.getElementById("selDeleteBtn"),
  selCancelBtn: document.getElementById("selCancelBtn"),

  moveDialog: document.getElementById("moveDialog"),
  moveDialogOptions: document.getElementById("moveDialogOptions"),
  moveDialogCancelBtn: document.getElementById("moveDialogCancelBtn"),
  moveDialogConfirmBtn: document.getElementById("moveDialogConfirmBtn"),

  mergeDialog: document.getElementById("mergeDialog"),
  mergeDialogOptions: document.getElementById("mergeDialogOptions"),
  mergeDialogCancelBtn: document.getElementById("mergeDialogCancelBtn"),
  mergeDialogConfirmBtn: document.getElementById("mergeDialogConfirmBtn"),

  convertDialog: document.getElementById("convertDialog"),
  convertDialogOptions: document.getElementById("convertDialogOptions"),
  convertDialogCancelBtn: document.getElementById("convertDialogCancelBtn"),

  calculateScoresBtn: document.getElementById("calculateScoresBtn"),
  scoresDialog: document.getElementById("scoresDialog"),
  scoresContent: document.getElementById("scoresContent"),
  scoresRecalculateBtn: document.getElementById("scoresRecalculateBtn"),
  scoresCloseBtn: document.getElementById("scoresCloseBtn"),
  totalScoreBadge: document.getElementById("totalScoreBadge"),

  resultSettingsBtn: document.getElementById("resultSettingsBtn"),
  resultSettingsDialog: document.getElementById("resultSettingsDialog"),
  resultSettingsContent: document.getElementById("resultSettingsContent"),
  resultSettingsCloseBtn: document.getElementById("resultSettingsCloseBtn"),
  securitySettingsBtn: document.getElementById("securitySettingsBtn"),
  securitySettingsDialog: document.getElementById("securitySettingsDialog"),
  securitySettingsContent: document.getElementById("securitySettingsContent"),
  securitySettingsCloseBtn: document.getElementById("securitySettingsCloseBtn"),
  testAsUserBtn: document.getElementById("testAsUserBtn"),

  editorFormPanel: document.getElementById("editorFormPanel"),
  previewPaneContent: document.getElementById("previewPaneContent"),

  editorSidebar: document.querySelector(".editor-sidebar"),
  editorPreviewPane: document.querySelector(".editor-preview-pane"),
  mobileSidebarToggle: document.getElementById("mobileSidebarToggle"),

  validationModal: document.getElementById("validationModal"),
  validationErrorList: document.getElementById("validationErrorList"),
  closeValidationBtn: document.getElementById("closeValidationBtn"),
};

/** @type {object} */
let draft = null;
let searchTerm = "";
let activeFilter = "all";
let bankSearchTerm = "";
/** Sidebar OUTLINE tree only — collapses a section's children in the navigation list. Independent of which section is the active tab in the center editor pane. */
const collapsedSectionIds = new Set();
/** Center editor pane: which of the 4 fixed sections is currently shown (tab-style — only one section renders at a time). */
let activeSectionId = null;
/** Multi-question group cards (passage/conversation/listening/image) are collapsed by default; a group's id lives here once the user expands it. */
const expandedGroupIds = new Set();
const revealedFields = new Set();
/** Extra blank option slots the admin has explicitly asked to add via "+ Add option", per question id — never auto-padded, only grows on a real user click. */
const revealedOptionSlots = new Map();
let previewTarget = null; // { sectionId, groupId } — also doubles as "current group/section" for Select Current Section/Group

/** Bulk-selection state. A plain Set independent of rendering, so it survives scroll/re-render. */
const selectedIds = new Set();
let lastClickedFlatIndex = null; // index into getVisibleQuestionRefsInOrder(), for Shift+Click range-select

let history = [];
let historyIndex = -1;
let suppressHistory = false;

/* =========================================================
   INIT
   ========================================================= */
function init() {
  initThemeToggle(els.toolbarDarkModeToggle);

  // Static (HTML-defined, not rebuilt per-render) popups also go through
  // register() so they're guaranteed closed on load regardless of markup —
  // the "sometimes visible immediately after page load" bug was exactly
  // this class of thing not being force-reset at startup.
  menuManager.register(els.filterMenu);
  menuManager.register(els.selectPanel);

  const id = getQueryParam("id");
  const loaded = id ? loadDraft(id) : null;
  draft = loaded ? migrateLegacyDraft(loaded) : createBlankDraft();
  ensureFixedSections(draft);
  setLastOpenedDraftId(draft.id);
  if (loaded) saveDraft(draft);

  els.testTitleInput.value = draft.title || "";
  pushHistory(true);

  if (draft.sections[0]) previewTarget = firstGroupTarget(draft.sections[0]);
  activeSectionId = draft.sections[0]?.id || null;

  renderAll();
  bindEvents();
  hidePageLoader();
}

function buildFixedSectionsSkeleton() {
  return FIXED_SECTIONS.map((fs) => ({ id: fs.id, title: fs.title, groups: [] }));
}

/**
 * Forces draft.sections into exactly the 4 fixed sections, in fixed
 * order. Existing sections (from before this constraint existed, or from
 * a hand-edited import) are matched to a canonical slot by title keyword;
 * anything that doesn't match a keyword has its groups folded into the
 * first section ("Scripts & Vocabulary") rather than being dropped — no
 * question is ever lost, it just may need re-sorting into the right
 * section by hand afterward.
 */
function ensureFixedSections(targetDraft) {
  const existing = Array.isArray(targetDraft.sections) ? targetDraft.sections : [];
  const alreadyFixed = existing.length === FIXED_SECTIONS.length && FIXED_SECTIONS.every((fs, i) => existing[i]?.id === fs.id);
  if (alreadyFixed) return;

  const canonical = buildFixedSectionsSkeleton();
  const matchIndexFor = (title) => {
    const t = (title || "").toLowerCase();
    if (/script|vocab/.test(t)) return 0;
    if (/conversation|expression/.test(t)) return 1;
    if (/listening/.test(t)) return 2;
    if (/reading/.test(t)) return 3;
    return -1;
  };

  existing.forEach((section) => {
    const idx = matchIndexFor(section.title);
    const target = idx === -1 ? canonical[0] : canonical[idx];
    target.groups.push(...(section.groups || []));
  });

  targetDraft.sections = canonical;
}

function createBlankDraft() {
  return {
    id: generateId("test"),
    title: "",
    categoryName: "",
    topic: "",
    description: "",
    language: "en",
    duration: 60,
    noTimeLimit: false,
    passMarks: null,
    active: true,
    premium: false,
    status: "draft",
    createdAt: new Date().toISOString(),
    sections: buildFixedSectionsSkeleton(),
  };
}

function firstGroupTarget(section) {
  const group = section.groups[0];
  return group ? { sectionId: section.id, groupId: group.id } : null;
}

/* =========================================================
   LEGACY DRAFT MIGRATION (unchanged from last session)
   ========================================================= */
function migrateLegacyDraft(raw) {
  if (Array.isArray(raw.sections)) {
    raw.sections.forEach((section) => {
      if (!Array.isArray(section.groups)) section.groups = [];
      section.groups.forEach((group) => {
        if (!Array.isArray(group.questions)) group.questions = [];
        group.questions = group.questions.map((q) => migrateQuestionToReference(q));
      });
    });
    if (!raw.status) raw.status = "draft";
    return raw;
  }
  if (!Array.isArray(raw.items)) return { ...raw, sections: [], status: raw.status || "draft" };

  const groups = raw.items.map((item) => {
    if (item.kind === "question") {
      return {
        id: generateId("group"), type: "single", title: "",
        imageUrl: item.imageUrl || null, audioUrl: item.audioUrl || null,
        questions: [migrateQuestionToReference(item)],
      };
    }
    const type = item.groupType === "conversationGroup" ? "conversation_group" : "passage_group";
    return {
      id: item.id || generateId("group"), type, title: item.title || "",
      passageText: type === "passage_group" ? item.passageText || "" : undefined,
      speakerAName: type === "conversation_group" ? item.speakerAName || "Speaker A" : undefined,
      speakerAText: type === "conversation_group" ? item.speakerAText || "" : undefined,
      speakerBName: type === "conversation_group" ? item.speakerBName || "Speaker B" : undefined,
      speakerBText: type === "conversation_group" ? item.speakerBText || "" : undefined,
      imageUrl: item.imageUrl || null, audioUrl: item.audioUrl || null,
      questions: (item.questions || []).map((q) => migrateQuestionToReference(q)),
    };
  });

  const { items, ...rest } = raw;
  showToast("This test was migrated from an older format into one section — split it up as needed.");
  return { ...rest, status: rest.status || "draft", sections: [{ id: generateId("section"), title: "Section 1", groups }] };
}

function migrateQuestionToReference(q) {
  const looksEmbedded = q && typeof q.question === "string";
  if (!looksEmbedded) return { id: q?.id || generateId("q") };
  const entry = newBankEntry({
    id: q.id || generateId("q"),
    question: q.question || "",
    options: q.options || ["", "", "", ""],
    correctOption: q.correctOption ?? null,
    explanation: q.explanation || "",
    marks: typeof q.marks === "number" ? q.marks : 1,
  });
  if (!getBankEntry(entry.id)) saveBankEntry(entry, { touchModified: false });
  return { id: entry.id };
}

/* =========================================================
   PERSISTENCE + UNDO/REDO
   ========================================================= */
const scheduleSave = debounce(persist, 400);

function persist() {
  els.saveStatus.textContent = "Saving…";
  els.saveStatus.classList.add("saving");
  const ok = saveDraft(draft);
  els.saveStatus.classList.remove("saving");
  els.saveStatus.textContent = ok ? "Saved" : "Save failed";
  if (!ok) els.saveStatus.classList.add("error");
  else els.saveStatus.classList.remove("error");
}

function pushHistory(isInitial = false) {
  if (suppressHistory) return;
  const snapshot = JSON.parse(JSON.stringify(draft));
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  if (history.length > MAX_HISTORY) history.shift();
  historyIndex = history.length - 1;
  if (!isInitial) updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  els.undoBtn.disabled = historyIndex <= 0;
  els.redoBtn.disabled = historyIndex >= history.length - 1;
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  suppressHistory = true;
  draft = JSON.parse(JSON.stringify(history[historyIndex]));
  suppressHistory = false;
  els.testTitleInput.value = draft.title || "";
  updateUndoRedoButtons();
  renderAll();
  scheduleSave();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex += 1;
  suppressHistory = true;
  draft = JSON.parse(JSON.stringify(history[historyIndex]));
  suppressHistory = false;
  els.testTitleInput.value = draft.title || "";
  updateUndoRedoButtons();
  renderAll();
  scheduleSave();
}

/** Structural changes snapshot immediately. Text/bank-field edits (including bulk Required/Bookmark) write straight to the shared bank and are not part of this per-test undo stack. */
function onDraftChanged({ structural = true, rerenderSidebar = true, rerenderDoc = true, rerenderPreview = true } = {}) {
  if (structural) pushHistory();
  updateUndoRedoButtons();
  if (rerenderSidebar) renderSidebar();
  if (rerenderDoc) renderDoc();
  if (rerenderPreview) renderPreview();
  renderProgressBar();
  scheduleSave();
}

function renderAll() {
  renderSidebar();
  renderDoc();
  renderPreview();
  renderBankPanel();
  updateSelectionToolbar();
  renderProgressBar();
}

/* =========================================================
   BANK ACCESS HELPERS
   ========================================================= */
function resolveRef(ref) {
  return getBankEntry(ref.id) || newBankEntry({ id: ref.id, question: "[Missing question — bank entry was deleted]" });
}
function saveQuestionField(ref, patch) {
  saveBankEntry({ ...resolveRef(ref), ...patch });
}

/* =========================================================
   LOOKUPS
   ========================================================= */
function findSection(sectionId) {
  return draft.sections.find((s) => s.id === sectionId) || null;
}
function findGroup(sectionId, groupId) {
  const section = findSection(sectionId);
  return section ? section.groups.find((g) => g.id === groupId) || null : null;
}
function findQuestionLocation(bankId) {
  for (const section of draft.sections) {
    for (const group of section.groups) {
      const idx = group.questions.findIndex((ref) => ref.id === bankId);
      if (idx !== -1) return { section, group, index: idx };
    }
  }
  return null;
}

/** Every question across every section/group, canonical document order, ignoring collapse/search/filter — used for Select All/Section/Group/Invert and all bulk actions. */
function getAllQuestionRefs() {
  const flat = [];
  draft.sections.forEach((section) => {
    section.groups.forEach((group) => {
      group.questions.forEach((ref) => flat.push({ ref, section, group }));
    });
  });
  return flat;
}
/** Only currently-rendered questions — i.e. those with an actual checkbox in the DOM right now: must be in the active section's tab, and (for multi-question groups) in an expanded group, with search/filter applied. Used for Shift+Click range-select so the range matches what's visually between the two clicks. */
function getVisibleQuestionRefsInOrder() {
  const flat = [];
  const section = findSection(activeSectionId);
  if (!section) return flat;
  section.groups.forEach((group) => {
    const rendered = group.type === "single" || expandedGroupIds.has(group.id) || !!searchTerm;
    if (!rendered) return; // collapsed groups show no question cards, so no checkboxes to range-select
    group.questions.forEach((ref) => {
      if (questionMatchesSearchAndFilter(ref, group, section)) flat.push({ ref, section, group });
    });
  });
  return flat;
}
/** Selected questions, in canonical document order (needed so bulk Duplicate/Move "maintain order"). */
function selectedRefsInOrder() {
  return getAllQuestionRefs().filter((x) => selectedIds.has(x.ref.id));
}

/* =========================================================
   FACTORIES
   ========================================================= */
function createNewReference() {
  const entry = newBankEntry();
  saveBankEntry(entry, { touchModified: false });
  return { id: entry.id };
}
function newGroup(type) {
  const base = {
    id: generateId("group"), type,
    title: type === "conversation_group" ? "New Conversation" : type === "passage_group" ? "New Passage" : "",
    imageUrl: null, audioUrl: null,
    questions: type === "single" ? [createNewReference()] : [],
  };
  if (type === "conversation_group") {
    base.speakerAName = "Speaker A"; base.speakerAText = "";
    base.speakerBName = "Speaker B"; base.speakerBText = "";
  }
  if (type === "passage_group") base.passageText = "";
  return base;
}

function addGroupToSection(sectionId, type) {
  const section = findSection(sectionId);
  if (!section) return;
  const group = newGroup(type);
  section.groups.push(group);
  collapsedSectionIds.delete(sectionId);
  expandedGroupIds.add(group.id); // freshly created — show it open so the user can fill it in right away
  onDraftChanged();
  requestAnimationFrame(() => scrollToGroup(group.id));
}

function addQuestionToSection(sectionId) {
  const section = findSection(sectionId);
  if (!section) return;
  const group = newGroup("single");
  section.groups.push(group);
  collapsedSectionIds.delete(sectionId);
  onDraftChanged();
  requestAnimationFrame(() => scrollToGroup(group.id));
}

function scrollToGroup(groupId) {
  document.getElementById(`group-doc-${groupId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  closeMobilePanels();
}
function scrollToQuestion(bankId) {
  document.getElementById(`question-doc-${bankId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  closeMobilePanels();
}

/* =========================================================
   MOVE UP / DOWN (single-item)
   ========================================================= */
function moveGroupUp(sectionId, groupId) { moveGroupBy(sectionId, groupId, -1); }
function moveGroupDown(sectionId, groupId) { moveGroupBy(sectionId, groupId, 1); }
function moveGroupBy(sectionId, groupId, delta) {
  const section = findSection(sectionId);
  if (!section) return;
  const index = section.groups.findIndex((g) => g.id === groupId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= section.groups.length) return;
  [section.groups[index], section.groups[target]] = [section.groups[target], section.groups[index]];
  onDraftChanged();
}

function moveQuestionUp(sectionId, groupId, bankId) { moveQuestionBy(sectionId, groupId, bankId, -1); }
function moveQuestionDown(sectionId, groupId, bankId) { moveQuestionBy(sectionId, groupId, bankId, 1); }
function moveQuestionBy(sectionId, groupId, bankId, delta) {
  const group = findGroup(sectionId, groupId);
  if (!group) return;
  if (group.type === "single") {
    moveGroupBy(sectionId, groupId, delta);
    return;
  }
  const index = group.questions.findIndex((ref) => ref.id === bankId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= group.questions.length) return;
  [group.questions[index], group.questions[target]] = [group.questions[target], group.questions[index]];
  onDraftChanged();
}

/* =========================================================
   MERGE WITH NEXT / PREVIOUS (single-item, unchanged)
   ========================================================= */
function mergeWithNext(sectionId, groupId) {
  const section = findSection(sectionId);
  const group = findGroup(sectionId, groupId);
  if (!section || !group || group.type !== "single") return;
  const index = section.groups.findIndex((g) => g.id === groupId);
  if (index === section.groups.length - 1) return;
  const nextSlot = section.groups[index + 1];
  const currentRef = group.questions[0];

  if (nextSlot.type === "single") {
    const merged = newGroup("passage_group");
    merged.questions = [currentRef, nextSlot.questions[0]];
    section.groups.splice(index, 2, merged);
    expandedGroupIds.add(merged.id);
    showToast("Merged into a new Passage Group");
    onDraftChanged();
    requestAnimationFrame(() => scrollToGroup(merged.id));
    return;
  }
  if (nextSlot.questions.length >= MAX_GROUP_QUESTIONS) {
    showToast(`"${nextSlot.title || GROUP_TYPE_LABELS[nextSlot.type]}" already has the maximum of ${MAX_GROUP_QUESTIONS} questions.`, "error");
    return;
  }
  nextSlot.questions.unshift(currentRef);
  section.groups.splice(index, 1);
  expandedGroupIds.add(nextSlot.id);
  showToast(`Merged into "${nextSlot.title || GROUP_TYPE_LABELS[nextSlot.type]}"`);
  onDraftChanged();
  requestAnimationFrame(() => scrollToGroup(nextSlot.id));
}

function mergeWithPrevious(sectionId, groupId) {
  const section = findSection(sectionId);
  const group = findGroup(sectionId, groupId);
  if (!section || !group || group.type !== "single") return;
  const index = section.groups.findIndex((g) => g.id === groupId);
  if (index === 0) return;
  const prevSlot = section.groups[index - 1];
  const currentRef = group.questions[0];

  if (prevSlot.type === "single") {
    const merged = newGroup("passage_group");
    merged.questions = [prevSlot.questions[0], currentRef];
    section.groups.splice(index - 1, 2, merged);
    expandedGroupIds.add(merged.id);
    showToast("Merged into a new Passage Group");
    onDraftChanged();
    requestAnimationFrame(() => scrollToGroup(merged.id));
    return;
  }
  if (prevSlot.questions.length >= MAX_GROUP_QUESTIONS) {
    showToast(`"${prevSlot.title || GROUP_TYPE_LABELS[prevSlot.type]}" already has the maximum of ${MAX_GROUP_QUESTIONS} questions.`, "error");
    return;
  }
  prevSlot.questions.push(currentRef);
  section.groups.splice(index, 1);
  expandedGroupIds.add(prevSlot.id);
  showToast(`Merged into "${prevSlot.title || GROUP_TYPE_LABELS[prevSlot.type]}"`);
  onDraftChanged();
  requestAnimationFrame(() => scrollToGroup(prevSlot.id));
}

/* =========================================================
   CONVERT (single-item, unchanged)
   ========================================================= */
function convertStandaloneToGroup(sectionId, groupId, newType) {
  const group = findGroup(sectionId, groupId);
  if (!group || group.type !== "single") return;
  applyGroupTypeFields(group, newType);
  expandedGroupIds.add(groupId);
  showToast(`Converted to ${GROUP_TYPE_LABELS[newType]} — add more questions to complete it`);
  onDraftChanged();
  requestAnimationFrame(() => scrollToGroup(groupId));
}

function convertGroupType(sectionId, groupId, newType) {
  const group = findGroup(sectionId, groupId);
  if (!group || group.type === "single" || group.type === newType) return;
  applyGroupTypeFields(group, newType);
  showToast(`Converted to ${GROUP_TYPE_LABELS[newType]}`);
  onDraftChanged();
}

function applyGroupTypeFields(group, newType) {
  group.type = newType;
  delete group.passageText;
  delete group.speakerAName;
  delete group.speakerAText;
  delete group.speakerBName;
  delete group.speakerBText;
  if (newType === "passage_group") {
    group.passageText = "";
    if (!group.title) group.title = "New Passage";
  } else if (newType === "conversation_group") {
    group.speakerAName = "Speaker A";
    group.speakerAText = "";
    group.speakerBName = "Speaker B";
    group.speakerBText = "";
    if (!group.title) group.title = "New Conversation";
  }
}

/* =========================================================
   DUPLICATE / DELETE / UNGROUP (single-item)
   ========================================================= */
function duplicateGroup(sectionId, groupId) {
  const section = findSection(sectionId);
  const group = findGroup(sectionId, groupId);
  if (!section || !group) return;
  const copy = JSON.parse(JSON.stringify(group));
  copy.id = generateId("group");
  if (copy.title) copy.title = `${copy.title} (Copy)`;
  const index = section.groups.findIndex((g) => g.id === groupId);
  section.groups.splice(index + 1, 0, copy);
  if (expandedGroupIds.has(groupId)) expandedGroupIds.add(copy.id); // mirror the original's expand/collapse state
  showToast("Group duplicated (still references the same bank questions)");
  onDraftChanged();
}

async function deleteGroup(sectionId, groupId) {
  const section = findSection(sectionId);
  const group = findGroup(sectionId, groupId);
  if (!section || !group) return;
  const label = group.type === "single" ? "this question from the test" : `"${group.title || "this group"}" from the test`;
  const confirmed = await confirmDialog(`Remove ${label}? The underlying bank question(s) are NOT deleted.`, { confirmLabel: "Remove" });
  if (!confirmed) return;
  section.groups = section.groups.filter((g) => g.id !== groupId);
  showToast("Removed from test");
  onDraftChanged();
}

function ungroupGroup(sectionId, groupId) {
  const section = findSection(sectionId);
  const group = findGroup(sectionId, groupId);
  if (!section || !group || group.type === "single") return;
  const index = section.groups.findIndex((g) => g.id === groupId);
  const singles = group.questions.map((ref) => ({ id: generateId("group"), type: "single", title: "", imageUrl: null, audioUrl: null, questions: [ref] }));
  section.groups.splice(index, 1, ...singles);
  showToast("Ungrouped");
  onDraftChanged();
}

function duplicateQuestion(bankId) {
  const loc = findQuestionLocation(bankId);
  if (!loc) return;
  const original = resolveRef({ id: bankId });
  const clone = newBankEntry({ ...original, id: generateId("bq") });
  saveBankEntry(clone, { touchModified: false });
  const newRef = { id: clone.id };

  if (loc.group.type === "single") {
    const groupCopy = { ...JSON.parse(JSON.stringify(loc.group)), id: generateId("group"), questions: [newRef] };
    const groupIndex = loc.section.groups.findIndex((g) => g.id === loc.group.id);
    loc.section.groups.splice(groupIndex + 1, 0, groupCopy);
  } else {
    loc.group.questions.splice(loc.index + 1, 0, newRef);
  }
  showToast("Duplicated as a new bank question");
  onDraftChanged();
}

async function removeQuestionFromTest(bankId) {
  const loc = findQuestionLocation(bankId);
  if (!loc) return;
  if (loc.group.type !== "single" && loc.group.questions.length <= 2) {
    showToast(`A ${GROUP_TYPE_LABELS[loc.group.type].toLowerCase()} needs at least 2 questions — remove the group instead.`, "error");
    return;
  }
  const confirmed = await confirmDialog("Remove this question from the test? The bank entry itself will not be deleted.", { confirmLabel: "Remove" });
  if (!confirmed) return;
  if (loc.group.type === "single") {
    loc.section.groups = loc.section.groups.filter((g) => g.id !== loc.group.id);
  } else {
    loc.group.questions.splice(loc.index, 1);
  }
  showToast("Removed from test");
  onDraftChanged();
}

/** Moves a single question (extracted as a standalone reference) into a different fixed section. If it was the only question in a shared group, that group is removed once empty. */
function moveQuestionToSection(bankId, targetSectionId) {
  const loc = findQuestionLocation(bankId);
  const targetSection = findSection(targetSectionId);
  if (!loc || !targetSection) return;
  if (loc.group.type === "single") {
    loc.section.groups = loc.section.groups.filter((g) => g.id !== loc.group.id);
  } else {
    loc.group.questions.splice(loc.index, 1);
    if (loc.group.questions.length === 0) loc.section.groups = loc.section.groups.filter((g) => g.id !== loc.group.id);
  }
  targetSection.groups.push({ id: generateId("group"), type: "single", title: "", imageUrl: null, audioUrl: null, questions: [{ id: bankId }] });
  activeSectionId = targetSectionId; // the question now lives in a different tab — switch to it so the move is visible
  showToast(`Moved to "${targetSection.title}"`);
  onDraftChanged();
  requestAnimationFrame(() => scrollToQuestion(bankId));
}


function toggleBookmark(bankId) {
  const entry = resolveRef({ id: bankId });
  saveBankEntry({ ...entry, bookmarked: !entry.bookmarked });
  renderDoc();
  renderSidebar();
}

/* =========================================================
   BULK SELECTION — checkbox handling
   ========================================================= */
function isSelectionMode() {
  return selectedIds.size > 0;
}

/** Shared by checkbox clicks: plain click toggles just this one; Shift+Click range-selects from the last-clicked visible question to this one. */
function handleSelectionClick(bankId, event) {
  if (event.shiftKey && lastClickedFlatIndex !== null) {
    const flat = getVisibleQuestionRefsInOrder();
    const idx = flat.findIndex((x) => x.ref.id === bankId);
    if (idx !== -1) {
      const [start, end] = [lastClickedFlatIndex, idx].sort((a, b) => a - b);
      for (let i = start; i <= end; i++) selectedIds.add(flat[i].ref.id);
    }
  } else {
    if (selectedIds.has(bankId)) selectedIds.delete(bankId);
    else selectedIds.add(bankId);
    const flat = getVisibleQuestionRefsInOrder();
    lastClickedFlatIndex = flat.findIndex((x) => x.ref.id === bankId);
  }
  updateSelectionToolbar();
  renderDoc();
}

function clearSelection() {
  selectedIds.clear();
  lastClickedFlatIndex = null;
  updateSelectionToolbar();
  renderDoc();
}
/** Same as clearSelection but skips its own re-render — used inside bulk actions that already trigger onDraftChanged()'s re-render right after. */
function clearSelectionSilently() {
  selectedIds.clear();
  lastClickedFlatIndex = null;
}

function selectAllQuestions() {
  getAllQuestionRefs().forEach(({ ref }) => selectedIds.add(ref.id));
  updateSelectionToolbar();
  renderDoc();
}
function selectCurrentSection() {
  if (!previewTarget) { showToast("Click into a question first.", "error"); return; }
  const section = findSection(previewTarget.sectionId);
  if (!section) return;
  section.groups.forEach((g) => g.questions.forEach((ref) => selectedIds.add(ref.id)));
  updateSelectionToolbar();
  renderDoc();
}
function selectCurrentGroup() {
  if (!previewTarget) { showToast("Click into a question first.", "error"); return; }
  const group = findGroup(previewTarget.sectionId, previewTarget.groupId);
  if (!group) return;
  group.questions.forEach((ref) => selectedIds.add(ref.id));
  updateSelectionToolbar();
  renderDoc();
}
function invertSelection() {
  const all = getAllQuestionRefs().map((x) => x.ref.id);
  const next = all.filter((id) => !selectedIds.has(id));
  selectedIds.clear();
  next.forEach((id) => selectedIds.add(id));
  updateSelectionToolbar();
  renderDoc();
}

function updateSelectionToolbar() {
  const count = selectedIds.size;
  els.selectionToolbar.hidden = count === 0;
  els.editorFormPanel.classList.toggle("has-floating-toolbar", count > 0);
  els.selectionCount.textContent = `${count} Question${count === 1 ? "" : "s"} Selected`;
}

/* =========================================================
   BULK ACTIONS
   ========================================================= */
function bulkRequired(value) {
  const ordered = selectedRefsInOrder();
  if (ordered.length === 0) return;
  ordered.forEach(({ ref }) => saveQuestionField(ref, { required: value }));
  showToast(`Required ${value ? "ON" : "OFF"} for ${ordered.length} question(s)`);
  renderDoc();
  renderSidebar();
  renderPreview();
}

function bulkBookmark(value) {
  const ordered = selectedRefsInOrder();
  if (ordered.length === 0) return;
  ordered.forEach(({ ref }) => {
    const entry = resolveRef(ref);
    saveBankEntry({ ...entry, bookmarked: value });
  });
  showToast(value ? `Bookmarked ${ordered.length} question(s)` : `Removed bookmark from ${ordered.length} question(s)`);
  renderDoc();
  renderSidebar();
}

function bulkDuplicate() {
  const ordered = selectedRefsInOrder();
  if (ordered.length === 0) return;
  ordered.forEach(({ ref, section, group }) => {
    const original = resolveRef(ref);
    const clone = newBankEntry({ ...original, id: generateId("bq") });
    saveBankEntry(clone, { touchModified: false });
    const newRef = { id: clone.id };
    if (group.type === "single") {
      const groupCopy = { ...JSON.parse(JSON.stringify(group)), id: generateId("group"), questions: [newRef] };
      const groupIndex = section.groups.findIndex((g) => g.id === group.id);
      section.groups.splice(groupIndex + 1, 0, groupCopy);
    } else {
      const idx = group.questions.findIndex((r) => r.id === ref.id);
      if (idx !== -1) group.questions.splice(idx + 1, 0, newRef);
    }
  });
  showToast(`Duplicated ${ordered.length} question(s)`);
  clearSelectionSilently();
  onDraftChanged();
}

function bulkUngroup() {
  const ordered = selectedRefsInOrder();
  const seen = new Set();
  const targets = [];
  ordered.forEach(({ section, group }) => {
    if (group.type === "single") return;
    const key = `${section.id}::${group.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ sectionId: section.id, groupId: group.id });
  });
  if (targets.length === 0) {
    showToast("No grouped questions selected.", "error");
    return;
  }
  targets.forEach(({ sectionId, groupId }) => {
    const section = findSection(sectionId);
    const group = findGroup(sectionId, groupId);
    if (!section || !group) return;
    const index = section.groups.findIndex((g) => g.id === groupId);
    const singles = group.questions.map((ref) => ({ id: generateId("group"), type: "single", title: "", imageUrl: null, audioUrl: null, questions: [ref] }));
    section.groups.splice(index, 1, ...singles);
  });
  showToast(`Ungrouped ${targets.length} group(s)`);
  clearSelectionSilently();
  onDraftChanged();
}

async function bulkDelete() {
  const ordered = selectedRefsInOrder();
  if (ordered.length === 0) return;
  const confirmed = await confirmDialog(`Remove ${ordered.length} selected question(s) from this test? Bank entries are not deleted.`, { confirmLabel: "Remove" });
  if (!confirmed) return;
  ordered.forEach(({ ref, section, group }) => {
    const g = findGroup(section.id, group.id);
    if (!g) return;
    if (g.type === "single") {
      section.groups = section.groups.filter((x) => x.id !== g.id);
    } else {
      g.questions = g.questions.filter((r) => r.id !== ref.id);
      if (g.questions.length === 0) section.groups = section.groups.filter((x) => x.id !== g.id);
    }
  });
  showToast("Deleted selection");
  clearSelectionSilently();
  onDraftChanged();
}

function extractSelectedAsStandaloneRefs() {
  const ordered = selectedRefsInOrder();
  const extracted = [];
  ordered.forEach(({ ref, section, group }) => {
    const g = findGroup(section.id, group.id);
    if (!g) return;
    if (g.type === "single") {
      section.groups = section.groups.filter((x) => x.id !== g.id);
    } else {
      const idx = g.questions.findIndex((r) => r.id === ref.id);
      if (idx === -1) return;
      g.questions.splice(idx, 1);
      if (g.questions.length === 0) section.groups = section.groups.filter((x) => x.id !== g.id);
    }
    extracted.push({ ref, sourceSectionId: section.id });
  });
  return extracted;
}

function bulkMoveToSection(targetSectionId) {
  const targetSection = findSection(targetSectionId);
  if (!targetSection) return;
  const refs = extractSelectedAsStandaloneRefs().map((x) => x.ref);
  refs.forEach((ref) => {
    targetSection.groups.push({ id: generateId("group"), type: "single", title: "", imageUrl: null, audioUrl: null, questions: [ref] });
  });
  activeSectionId = targetSectionId; // switch tabs so the moved questions are visible
  showToast(`Moved ${refs.length} question(s) to "${targetSection.title}"`);
  clearSelectionSilently();
  onDraftChanged();
}

/** Requires the selected standalone questions to be consecutive slots within one section — matches "when multiple CONSECUTIVE standalone questions are selected" from the spec. */
function bulkMerge(type) {
  const ordered = selectedRefsInOrder().filter((x) => x.group.type === "single");
  if (ordered.length < 2) {
    showToast("Select at least 2 standalone questions to merge.", "error");
    return;
  }
  const section = ordered[0].section;
  if (!ordered.every((x) => x.section.id === section.id)) {
    showToast("Selected questions must be in the same section to merge.", "error");
    return;
  }
  const indices = ordered.map((x) => section.groups.findIndex((g) => g.id === x.group.id)).sort((a, b) => a - b);
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
  if (!isContiguous) {
    showToast("Selected questions must be consecutive (no other questions/groups between them) to merge.", "error");
    return;
  }
  if (indices.length > MAX_GROUP_QUESTIONS) {
    showToast(`A group supports at most ${MAX_GROUP_QUESTIONS} questions.`, "error");
    return;
  }
  const refs = indices.map((idx) => section.groups[idx].questions[0]);
  const merged = newGroup(type);
  merged.questions = refs;
  section.groups.splice(indices[0], indices.length, merged);
  expandedGroupIds.add(merged.id);
  activeSectionId = section.id; // in case the selection spanned tabs via Select All, show the merged result
  showToast(`Merged ${refs.length} questions into a new ${GROUP_TYPE_LABELS[type]}`);
  clearSelectionSilently();
  onDraftChanged();
  requestAnimationFrame(() => scrollToGroup(merged.id));
}

function bulkConvert(type) {
  const ordered = selectedRefsInOrder().filter((x) => x.group.type === "single");
  if (ordered.length === 0) {
    showToast("Select standalone questions to convert.", "error");
    return;
  }
  ordered.forEach(({ section, group }) => {
    const g = findGroup(section.id, group.id);
    if (g) applyGroupTypeFields(g, type);
  });
  showToast(`Converted ${ordered.length} question(s) to ${GROUP_TYPE_LABELS[type]}`);
  clearSelectionSilently();
  onDraftChanged();
}

/* =========================================================
   MOVE / MERGE / CONVERT DIALOGS — the bulk-toolbar's Move,
   Merge, and Convert buttons open one of these centered
   <dialog> modals instead of a nested dropdown. Move & Merge
   use a radio-list + confirm button; Convert applies as soon
   as a card is clicked (matches the spec's mockups, which show
   no separate confirm button on that one).
   ========================================================= */
let moveDialogSelectedSectionId = null;
let mergeDialogSelectedType = null;

function openMoveDialog() {
  menuManager.closeAll();
  moveDialogSelectedSectionId = null;
  els.moveDialogConfirmBtn.disabled = true;
  els.moveDialogOptions.innerHTML = "";
  draft.sections.forEach((section, i) => {
    const radio = el("input", { type: "radio", name: "moveDialogSection", value: section.id });
    radio.addEventListener("change", () => {
      moveDialogSelectedSectionId = section.id;
      els.moveDialogConfirmBtn.disabled = false;
    });
    const option = el("label", { class: "dialog-radio-option" }, [radio, el("span", { text: section.title || `Section ${i + 1}` })]);
    els.moveDialogOptions.appendChild(option);
  });
  els.moveDialog.showModal();
}

function openMergeDialog() {
  menuManager.closeAll();
  mergeDialogSelectedType = null;
  els.mergeDialogConfirmBtn.disabled = true;
  els.mergeDialogOptions.innerHTML = "";
  GROUP_TYPES.forEach((type) => {
    const radio = el("input", { type: "radio", name: "mergeDialogType", value: type });
    radio.addEventListener("change", () => {
      mergeDialogSelectedType = type;
      els.mergeDialogConfirmBtn.disabled = false;
    });
    const option = el("label", { class: "dialog-radio-option" }, [radio, el("span", { text: `${GROUP_TYPE_ICONS[type]} ${GROUP_TYPE_LABELS[type]}` })]);
    els.mergeDialogOptions.appendChild(option);
  });
  els.mergeDialog.showModal();
}

function openConvertDialog() {
  menuManager.closeAll();
  els.convertDialogOptions.innerHTML = "";
  GROUP_TYPES.forEach((type) => {
    const card = el("button", { type: "button", class: "convert-card", onclick: () => { bulkConvert(type); els.convertDialog.close(); } }, [
      el("span", { class: "convert-card-icon", text: GROUP_TYPE_ICONS[type] }),
      el("span", { text: GROUP_TYPE_LABELS[type] }),
    ]);
    els.convertDialogOptions.appendChild(card);
  });
  els.convertDialog.showModal();
}

/* =========================================================
   ADD FROM QUESTION BANK — click, not drag
   ========================================================= */
function addBankReferenceToTest(bankId) {
  if (draft.sections.length === 0) {
    showToast("Add a section first.", "error");
    return;
  }
  const targetSection = draft.sections[draft.sections.length - 1];
  targetSection.groups.push({ id: generateId("group"), type: "single", title: "", imageUrl: null, audioUrl: null, questions: [{ id: bankId }] });
  activeSectionId = targetSection.id; // always added to the last section — switch tabs so it's visible
  showToast(`Added to "${targetSection.title}" (referenced, not copied)`);
  onDraftChanged();
  requestAnimationFrame(() => scrollToQuestion(bankId));
}

/* =========================================================
   SEARCH + FILTER
   ========================================================= */
function questionMatchesSearchAndFilter(ref, group, section) {
  const entry = resolveRef(ref);
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    const haystack = [entry.id, entry.question, section.title, group.title, ...(entry.tags || [])].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(term)) return false;
  }
  switch (activeFilter) {
    case "reading":
      return /reading/i.test(section.title);
    case "listening":
      return /listening/i.test(section.title) || group.type === "listening_group";
    case "passage":
      return group.type === "passage_group";
    case "standalone":
      return group.type === "single";
    case "bookmarked":
      return !!entry.bookmarked;
    case "incomplete":
      return !isQuestionComplete(entry);
    default:
      return true;
  }
}

/* =========================================================
   SIDEBAR
   ========================================================= */
function renderSidebar() {
  els.sidebarTree.innerHTML = "";
  if (draft.sections.length === 0) {
    els.sidebarTree.appendChild(el("p", { class: "empty-recent", text: "No sections yet — add one above." }));
    return;
  }

  let questionNumber = 0;
  const typeCounters = { passage_group: 0, conversation_group: 0, listening_group: 0, image_group: 0 };

  draft.sections.forEach((section) => {
    const collapsed = collapsedSectionIds.has(section.id);
    const header = el(
      "div",
      { class: "tree-section-header" + (section.id === activeSectionId ? " selected" : ""), onclick: () => { collapseSection(section.id, !collapsed); setActiveSection(section.id); } },
      [el("span", { text: `${collapsed ? "▶" : "▼"} ${section.title || "Untitled Section"}` })]
    );
    els.sidebarTree.appendChild(header);

    if (collapsed) return;
    const children = el("div", { class: "tree-section-children" });

    section.groups.forEach((group) => {
      if (group.type === "single") {
        questionNumber += 1;
        const ref = group.questions[0];
        if (!questionMatchesSearchAndFilter(ref, group, section)) return;
        const entry = resolveRef(ref);
        children.appendChild(buildSidebarQuestionRow(`Q${questionNumber}. ${entry.question || "Untitled question"}`, section.id, group.id, ref.id));
        return;
      }
      const startNumber = questionNumber + 1;
      questionNumber += group.questions.length;
      typeCounters[group.type] += 1;
      const visible = group.questions.some((ref) => questionMatchesSearchAndFilter(ref, group, section));
      if (!visible) return;

      children.appendChild(
        el("div", { class: "tree-group-header", onclick: () => navigateToGroup(section.id, group.id) }, [
          el("span", { text: `${GROUP_TYPE_ICONS[group.type]} ${GROUP_TYPE_LABELS[group.type]} (Q${startNumber}–Q${questionNumber})` }),
        ])
      );
      const groupChildren = el("div", { class: "tree-group-children" });
      group.questions.forEach((ref, i) => {
        if (!questionMatchesSearchAndFilter(ref, group, section)) return;
        const entry = resolveRef(ref);
        groupChildren.appendChild(buildSidebarQuestionRow(`Q${startNumber + i}. ${entry.question || "Untitled question"}`, section.id, group.id, ref.id));
      });
      children.appendChild(groupChildren);
    });

    els.sidebarTree.appendChild(children);
  });
}

function buildSidebarQuestionRow(label, sectionId, groupId, bankId) {
  return el("div", { class: "tree-item", onclick: () => navigateToQuestion(sectionId, groupId, bankId) }, [el("span", { class: "tree-item-label", text: label })]);
}

/** Sidebar OUTLINE tree only — expands/collapses the section's children in that navigation list; does not affect which section is shown in the center editor pane (that's `setActiveSection`). */
function collapseSection(sectionId, collapsed) {
  if (collapsed) collapsedSectionIds.add(sectionId);
  else collapsedSectionIds.delete(sectionId);
  renderSidebar();
}

function switchSidebarTab(tab) {
  const showBank = tab === "bank";
  els.sidebarTree.hidden = showBank;
  els.sidebarToolbarRow.hidden = showBank; // search/filters/select apply to the Outline only — Bank has its own search
  els.bankPanel.hidden = !showBank;
  els.outlineTabBtn.classList.toggle("active", !showBank);
  els.bankTabBtn.classList.toggle("active", showBank);
  els.outlineTabBtn.setAttribute("aria-selected", String(!showBank));
  els.bankTabBtn.setAttribute("aria-selected", String(showBank));
  if (showBank) renderBankPanel();
}

function renderBankPanel() {
  if (els.bankPanel.hidden) return;
  els.bankPanelList.innerHTML = "";
  const usage = computeUsageCounts();
  const entries = listBankEntries().filter((entry) => {
    if (!bankSearchTerm) return true;
    const term = bankSearchTerm.toLowerCase();
    return [entry.id, entry.question, ...(entry.tags || [])].filter(Boolean).join(" ").toLowerCase().includes(term);
  });

  if (entries.length === 0) {
    els.bankPanelList.appendChild(el("p", { class: "empty-recent", text: "No bank questions match your search." }));
    return;
  }

  entries.slice(0, 200).forEach((entry) => {
    const item = el("div", {
      class: "bank-panel-item",
      role: "button",
      tabindex: "0",
      onclick: () => addBankReferenceToTest(entry.id),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addBankReferenceToTest(entry.id); } },
    }, [
      el("div", { text: entry.question || "(untitled question)" }),
      el("div", { class: "bank-panel-item-meta", text: `Used ${usage[entry.id] || 0}×${entry.bookmarked ? " · ★" : ""} · click to add` }),
    ]);
    els.bankPanelList.appendChild(item);
  });
}

/* =========================================================
   TOP PROGRESS BAR — the 4 fixed sections
   ========================================================= */
function computeSectionStats(section) {
  let questionCount = 0;
  let marks = 0;
  let incompleteCount = 0;

  section.groups.forEach((group) => {
    if (group.type !== "single") {
      if (group.type === "passage_group" && !(group.passageText || "").trim()) incompleteCount += 1;
      if ((group.type === "listening_group" || group.type === "conversation_group") && !group.audioUrl) incompleteCount += 1;
      if (group.type === "image_group" && !group.imageUrl) incompleteCount += 1;
      if (group.type === "conversation_group" && (!(group.speakerAText || "").trim() || !(group.speakerBText || "").trim())) incompleteCount += 1;
    }
    group.questions.forEach((ref) => {
      questionCount += 1;
      const entry = resolveRef(ref);
      marks += typeof entry.marks === "number" ? entry.marks : 0;
      if (!isQuestionComplete(entry)) incompleteCount += 1;
    });
  });

  const groupCount = section.groups.length;
  // Heuristic only (see ESTIMATED_MINUTES_PER_QUESTION's doc comment) — not the real per-test timer.
  const estMinutes = questionCount === 0 ? 0 : Math.max(1, Math.round(questionCount * ESTIMATED_MINUTES_PER_QUESTION));
  return { questionCount, groupCount, marks, incompleteCount, estMinutes };
}

/** The score-calculation engine — reads live from `draft`, never from a cached/stale copy, so it's always correct whenever it's called (including every time the modal is opened). Every number here is derived, never hardcoded. */
function computeScoreSummary() {
  const perSection = FIXED_SECTIONS.map((fs) => {
    const section = findSection(fs.id);
    const stats = section ? computeSectionStats(section) : { questionCount: 0, groupCount: 0, marks: 0 };
    return { key: fs.key, title: fs.title, icon: fs.icon, ...stats };
  });

  const totalQuestions = perSection.reduce((s, x) => s + x.questionCount, 0);
  const totalGroups = perSection.reduce((s, x) => s + x.groupCount, 0);
  const totalMarks = perSection.reduce((s, x) => s + x.marks, 0);

  let requiredCount = 0;
  draft.sections.forEach((section) => {
    section.groups.forEach((group) => {
      group.questions.forEach((ref) => {
        const entry = resolveRef(ref);
        if (entry.required) requiredCount += 1;
      });
    });
  });
  const optionalCount = totalQuestions - requiredCount;

  const sectionsWithPct = perSection.map((s) => ({ ...s, percentage: totalMarks > 0 ? Math.round((s.marks / totalMarks) * 1000) / 10 : 0 }));

  return {
    totalQuestions, totalGroups, totalMarks, requiredCount, optionalCount,
    perSection: sectionsWithPct,
    passMarks: typeof draft.passMarks === "number" ? draft.passMarks : null,
    passPercentage: typeof draft.passPercentage === "number" ? draft.passPercentage : null,
  };
}

/** Lazily creates draft.resultSettings (deep-merged with defaults, so an older draft that predates this feature — or one missing just a few fields — still gets a complete, valid object) the first time it's needed, rather than requiring every draft to have been created after this feature existed. */
function getResultSettings() {
  if (!draft.resultSettings) draft.resultSettings = JSON.parse(JSON.stringify(DEFAULT_RESULT_SETTINGS));
  const rs = draft.resultSettings;
  rs.sectionLabels = rs.sectionLabels || {};
  FIXED_SECTIONS.forEach((fs) => {
    if (!rs.sectionLabels[fs.id]) rs.sectionLabels[fs.id] = { ...DEFAULT_RESULT_SETTINGS.sectionLabels[fs.id] };
  });
  return rs;
}

function resultSettingsField(label, control) {
  return el("div", { class: "field-group" }, [el("label", { class: "field-label", text: label }), control]);
}

function resultSettingsTextInput(rs, key, placeholder = "") {
  const input = el("input", { type: "text", class: "text-input", value: rs[key] ?? "", placeholder });
  input.addEventListener("input", (e) => { rs[key] = e.target.value; persist(); });
  return input;
}

function resultSettingsNumberInput(rs, key, { allowNull = false } = {}) {
  const input = el("input", { type: "number", class: "text-input", value: rs[key] ?? "" });
  input.addEventListener("input", (e) => {
    rs[key] = e.target.value === "" ? (allowNull ? null : 0) : Number(e.target.value);
    persist();
    renderTotalScoreBadge();
  });
  return input;
}

function renderResultSettingsDialog() {
  const rs = getResultSettings();
  const wrap = els.resultSettingsContent;
  wrap.innerHTML = "";

  wrap.appendChild(el("h3", { class: "scores-block-title", text: "Result Screen Title" }));
  wrap.appendChild(resultSettingsField("Japanese title", resultSettingsTextInput(rs, "titleJa")));
  wrap.appendChild(resultSettingsField("English title", resultSettingsTextInput(rs, "titleEn")));

  wrap.appendChild(el("h3", { class: "scores-block-title", text: "Score Range & Passing" }));
  wrap.appendChild(resultSettingsField("Minimum score (bar start)", resultSettingsNumberInput(rs, "minScore")));
  wrap.appendChild(resultSettingsField("Maximum score (bar end)", resultSettingsNumberInput(rs, "maxScore")));
  wrap.appendChild(resultSettingsField("Passing score", resultSettingsNumberInput(rs, "passingScore")));

  wrap.appendChild(el("h3", { class: "scores-block-title", text: "Score Calculation Mode" }));
  const modeWrap = el("div", { class: "dialog-radio-list" });
  [["raw", "Raw Points — displayed score is the marks scored, as-is"], ["percentage", "Percentage — marks scored ÷ total marks, scaled into the min/max range above"], ["scaled", "Scaled Score — converts a raw range into a separate final range (e.g. 0–100 raw → 10–250 final)"]].forEach(([value, label]) => {
    const radio = el("input", { type: "radio", name: "resultScoreMode", value, checked: rs.scoreMode === value ? "" : null });
    radio.addEventListener("change", () => { rs.scoreMode = value; persist(); renderResultSettingsDialog(); });
    modeWrap.appendChild(el("label", { class: "dialog-radio-option" }, [radio, el("span", { text: label })]));
  });
  wrap.appendChild(modeWrap);

  if (rs.scoreMode === "scaled") {
    const scaledRow = el("div", { class: "field-row" });
    scaledRow.appendChild(resultSettingsField("Raw minimum", resultSettingsNumberInput(rs, "rawMin")));
    scaledRow.appendChild(resultSettingsField("Raw maximum (blank = test's total marks)", resultSettingsNumberInput(rs, "rawMax", { allowNull: true })));
    wrap.appendChild(scaledRow);
    const finalRow = el("div", { class: "field-row" });
    finalRow.appendChild(resultSettingsField("Final minimum", resultSettingsNumberInput(rs, "finalMin")));
    finalRow.appendChild(resultSettingsField("Final maximum", resultSettingsNumberInput(rs, "finalMax")));
    wrap.appendChild(finalRow);
  }

  wrap.appendChild(el("h3", { class: "scores-block-title", text: "Result Messages" }));
  wrap.appendChild(resultSettingsField("Passed — Japanese", resultSettingsTextInput(rs, "passedJa")));
  wrap.appendChild(resultSettingsField("Passed — English", resultSettingsTextInput(rs, "passedEn")));
  wrap.appendChild(resultSettingsField("Not Passed — Japanese", resultSettingsTextInput(rs, "failedJa")));
  wrap.appendChild(resultSettingsField("Not Passed — English", resultSettingsTextInput(rs, "failedEn")));

  wrap.appendChild(el("h3", { class: "scores-block-title", text: "Section Display Names" }));
  FIXED_SECTIONS.forEach((fs) => {
    const label = rs.sectionLabels[fs.id];
    const row = el("div", { class: "field-row" });
    const jaInput = el("input", { type: "text", class: "text-input", value: label.ja || "" });
    jaInput.addEventListener("input", (e) => { label.ja = e.target.value; persist(); });
    const enInput = el("input", { type: "text", class: "text-input", value: label.en || "" });
    enInput.addEventListener("input", (e) => { label.en = e.target.value; persist(); });
    row.appendChild(resultSettingsField(`${fs.icon} ${fs.title} — Japanese`, jaInput));
    row.appendChild(resultSettingsField(`${fs.icon} ${fs.title} — English`, enInput));
    wrap.appendChild(row);
  });
}

/** Same lazy-init/deep-merge pattern as getResultSettings() above — an older draft (or one missing just a couple of fields) still gets a complete, valid settings object rather than needing a one-time migration step. */
function getSecuritySettings() {
  if (!draft.securitySettings) draft.securitySettings = { ...DEFAULT_SECURITY_SETTINGS };
  else draft.securitySettings = { ...DEFAULT_SECURITY_SETTINGS, ...draft.securitySettings };
  return draft.securitySettings;
}

function securityCheckboxField(sec, key, label) {
  const checkbox = el("input", { type: "checkbox", checked: sec[key] ? "" : null });
  checkbox.addEventListener("change", (e) => { sec[key] = e.target.checked; persist(); });
  return el("label", { class: "dialog-radio-option" }, [checkbox, el("span", { text: label })]);
}

function renderSecuritySettingsDialog() {
  const sec = getSecuritySettings();
  const wrap = els.securitySettingsContent;
  wrap.innerHTML = "";

  wrap.appendChild(el("h3", { class: "scores-block-title", text: "Restrictions" }));
  const checksWrap = el("div", { class: "dialog-radio-list" });
  [
    ["disableTextSelection", "Disable text selection"],
    ["disableCopy", "Disable copy"],
    ["disableCut", "Disable cut"],
    ["disablePaste", "Disable paste"],
    ["disableContextMenu", "Disable right-click context menu"],
    ["disablePrint", "Disable print"],
    ["requestFullscreen", "Request fullscreen on exam start"],
    ["detectFullscreenExit", "Detect fullscreen exit"],
    ["detectTabSwitch", "Detect tab switching"],
    ["blockShortcuts", "Block common browser shortcuts (copy/print/devtools/etc.)"],
    ["trackSecurityEvents", "Track security events on the submitted result"],
  ].forEach(([key, label]) => checksWrap.appendChild(securityCheckboxField(sec, key, label)));
  wrap.appendChild(checksWrap);

  wrap.appendChild(el("h3", { class: "scores-block-title", text: "Violation Threshold" }));
  wrap.appendChild(resultSettingsField("Warn after this many violations", resultSettingsNumberInput(sec, "maxViolations")));

  const modeWrap = el("div", { class: "dialog-radio-list" });
  [["continue", "Continue — no extra action once the threshold is reached"], ["warn", "Warn — show a stronger final warning"], ["auto_submit", "Auto-submit — end the exam automatically"]].forEach(([value, label]) => {
    const radio = el("input", { type: "radio", name: "securityThresholdAction", value, checked: sec.thresholdAction === value ? "" : null });
    radio.addEventListener("change", () => { sec.thresholdAction = value; persist(); });
    modeWrap.appendChild(el("label", { class: "dialog-radio-option" }, [radio, el("span", { text: label })]));
  });
  wrap.appendChild(modeWrap);
}

function renderScoresModal() {
  const s = computeScoreSummary();
  const row = (label, value) => el("div", { class: "scores-row" }, [el("span", { text: label }), el("span", { class: "scores-value", text: String(value) })]);

  els.scoresContent.innerHTML = "";

  const totalBlock = el("div", { class: "scores-block" }, [
    el("h3", { text: "Total Test" }),
    row("Total Questions", s.totalQuestions),
    row("Total Groups", s.totalGroups),
    row("Total Points", s.totalMarks),
    row("Required Questions", s.requiredCount),
    row("Optional Questions", s.optionalCount),
  ]);
  els.scoresContent.appendChild(totalBlock);

  if (s.passMarks !== null || s.passPercentage !== null) {
    const passBlock = el("div", { class: "scores-block" }, [el("h3", { text: "Passing Requirement" })]);
    if (s.passMarks !== null) passBlock.appendChild(row("Pass Marks", s.passMarks));
    if (s.passPercentage !== null) passBlock.appendChild(row("Pass Percentage", `${s.passPercentage}%`));
    if (s.passMarks !== null && s.totalMarks > 0) passBlock.appendChild(row("Estimated Passing Requirement", `${s.passMarks} / ${s.totalMarks} pts`));
    els.scoresContent.appendChild(passBlock);
  }

  const sectionsBlock = el("div", { class: "scores-block" }, [el("h3", { text: "Section Scores" })]);
  s.perSection.forEach((sec) => {
    sectionsBlock.appendChild(
      el("div", { class: "scores-section" }, [
        el("div", { class: "scores-section-title", text: `${sec.icon} ${sec.title}` }),
        row("Questions", sec.questionCount),
        row("Groups", sec.groupCount),
        row("Points", sec.marks),
        row("Percentage", `${sec.percentage}%`),
      ])
    );
  });
  els.scoresContent.appendChild(sectionsBlock);

  const grandBlock = el("div", { class: "scores-block" }, [
    el("h3", { text: "Total" }),
    row("Questions", s.totalQuestions),
    row("Points", s.totalMarks),
  ]);
  els.scoresContent.appendChild(grandBlock);
}

/** The one place every part of the UI reads totals from — the header badge, the section tabs (via computeSectionStats, which this also calls), and the Calculate Scores modal all trace back to this same function, so they can never disagree. */
function renderTotalScoreBadge() {
  const s = computeScoreSummary();
  els.totalScoreBadge.textContent = `Total: ${s.totalQuestions} Question${s.totalQuestions === 1 ? "" : "s"} | ${s.totalMarks} Point${s.totalMarks === 1 ? "" : "s"}`;
}

function renderProgressBar() {
  renderTotalScoreBadge();
  els.progressBarSections.innerHTML = "";
  FIXED_SECTIONS.forEach((fs) => {
    const section = findSection(fs.id);
    if (!section) return;
    const stats = computeSectionStats(section);
    const hasContent = stats.questionCount > 0;
    const complete = hasContent && stats.incompleteCount === 0;
    const statusGlyph = complete ? "✓" : hasContent ? "⚠" : "";
    const stateClass = complete ? " complete" : hasContent ? " warning" : "";
    const isActive = fs.id === activeSectionId;

    const pill = el("button", {
      type: "button",
      class: "progress-section-pill" + stateClass + (isActive ? " active" : ""),
      "aria-selected": String(isActive),
      role: "tab",
      onclick: () => setActiveSection(fs.id),
    }, [
      el("div", { class: "progress-section-title-row" }, [
        el("span", { text: fs.icon }),
        el("span", { text: fs.title }),
        el("span", { class: "progress-section-status", text: statusGlyph }),
      ]),
      el("div", { class: "progress-section-stats", text: `${stats.questionCount} Question${stats.questionCount === 1 ? "" : "s"} • ${stats.groupCount} Group${stats.groupCount === 1 ? "" : "s"} • ${stats.marks} Point${stats.marks === 1 ? "" : "s"} • ~${stats.estMinutes} min` }),
    ]);
    els.progressBarSections.appendChild(pill);
  });
}

/** Switches which of the 4 fixed sections the center editor pane shows — the tabs above act like Google Forms sections, one visible at a time. */
function setActiveSection(sectionId) {
  if (activeSectionId === sectionId) return;
  menuManager.closeAll(); // section change closes every open popup
  activeSectionId = sectionId;
  const section = findSection(sectionId);
  const firstGroup = section && section.groups[0];
  if (firstGroup) setPreviewTarget(sectionId, firstGroup.id);
  renderDoc();
  renderProgressBar();
  closeMobilePanels();
}

/** Question numbers stay continuous across all 4 sections even though only one is rendered at a time — this returns how many questions come before `sectionId` in canonical section order. */
function computeSectionStartNumber(sectionId) {
  let count = 0;
  for (const section of draft.sections) {
    if (section.id === sectionId) return count;
    section.groups.forEach((g) => { count += g.questions.length; });
  }
  return count;
}

/** Jumps the center pane to a given section/group (switching tabs if needed) and expands the group if it's a collapsed multi-question group — used by the sidebar Outline tree and by actions like "Move To Section" that can land a question in a section other than the one currently open. */
function navigateToGroup(sectionId, groupId) {
  menuManager.closeAll(); // switching to a different group counts as a question/section change
  activeSectionId = sectionId;
  expandedGroupIds.add(groupId);
  setPreviewTarget(sectionId, groupId);
  renderDoc();
  renderProgressBar();
  requestAnimationFrame(() => scrollToGroup(groupId));
  closeMobilePanels();
}
function navigateToQuestion(sectionId, groupId, bankId) {
  menuManager.closeAll();
  activeSectionId = sectionId;
  expandedGroupIds.add(groupId);
  setPreviewTarget(sectionId, groupId);
  renderDoc();
  renderProgressBar();
  requestAnimationFrame(() => scrollToQuestion(bankId));
  closeMobilePanels();
}

/* =========================================================
   DOCUMENT EDITOR (center panel) — shows only the active
   section (tab-style); the other 3 sections stay in `draft`
   untouched, just not rendered until their tab is clicked.
   ========================================================= */
function renderDoc() {
  els.editorFormPanel.innerHTML = "";
  const root = el("div", { class: "doc-root" });

  if (draft.sections.length === 0) {
    root.appendChild(el("div", { class: "empty-state" }, [el("h2", { text: "No sections yet" }), el("p", { text: "Click \"+ Add Section\" in the sidebar to start building your test." })]));
    els.editorFormPanel.appendChild(root);
    return;
  }

  if (!activeSectionId || !findSection(activeSectionId)) activeSectionId = draft.sections[0].id;
  const section = findSection(activeSectionId);
  const sectionIndex = draft.sections.findIndex((s) => s.id === section.id);
  const typeCounters = { passage_group: 0, conversation_group: 0, listening_group: 0, image_group: 0 };
  const startNumber = computeSectionStartNumber(section.id);

  root.appendChild(buildSectionDoc(section, sectionIndex, () => renderGroupsAndNumbering(section, startNumber, typeCounters).body));

  els.editorFormPanel.appendChild(root);
}

function renderGroupsAndNumbering(section, startNumber, typeCounters) {
  let questionNumber = startNumber;
  const body = el("div", { class: "section-doc-body" });

  section.groups.forEach((group, groupIndex) => {
    if (group.type === "single") {
      questionNumber += 1;
      const ref = group.questions[0];
      if (questionMatchesSearchAndFilter(ref, group, section)) {
        body.appendChild(buildQuestionCard(ref, questionNumber, section, group, true, groupIndex, section.groups.length));
      }
      return;
    }

    const startQ = questionNumber + 1;
    questionNumber += group.questions.length;
    typeCounters[group.type] += 1;
    if (group.questions.some((ref) => questionMatchesSearchAndFilter(ref, group, section))) {
      body.appendChild(buildGroupBlock(section, group, startQ, groupIndex, section.groups.length));
    }
  });

  body.appendChild(
    el("div", { class: "section-doc-add-row" }, [
      addGroupDropdown(section.id),
      el("button", { type: "button", class: "btn btn-ghost btn-sm", text: "+ Question", onclick: () => addQuestionToSection(section.id) }),
    ])
  );

  return { body, questionNumber };
}

function addGroupDropdown(sectionId) {
  const menu = menuManager.register(el("div", { class: "dropdown-menu" }, [
    el("button", { type: "button", text: "📄 Passage Group", onclick: () => { addGroupToSection(sectionId, "passage_group"); menuManager.close(menu); } }),
    el("button", { type: "button", text: "💬 Conversation Group", onclick: () => { addGroupToSection(sectionId, "conversation_group"); menuManager.close(menu); } }),
    el("button", { type: "button", text: "🎧 Listening Group", onclick: () => { addGroupToSection(sectionId, "listening_group"); menuManager.close(menu); } }),
    el("button", { type: "button", text: "🖼 Image Group", onclick: () => { addGroupToSection(sectionId, "image_group"); menuManager.close(menu); } }),
  ]));
  const btn = el("button", { type: "button", class: "btn btn-secondary btn-sm", text: "+ New Group ▾", onclick: (e) => { e.stopPropagation(); menuManager.toggle(menu); } });
  return el("div", { class: "dropdown" }, [btn, menu]);
}

function buildThreeDotMenu(items) {
  const menu = menuManager.register(el("div", { class: "dropdown-menu" }));
  items.forEach((item) => {
    if (item === null) {
      menu.appendChild(el("div", { class: "dropdown-divider" }));
      return;
    }
    menu.appendChild(
      el("button", {
        type: "button",
        class: item.danger ? "dropdown-danger" : null,
        text: item.label,
        onclick: () => { menuManager.close(menu); item.onClick(); },
      })
    );
  });
  const btn = el("button", { type: "button", class: "icon-btn icon-btn-xs", "aria-label": "More actions", title: "More actions", text: "⋮", onclick: (e) => { e.stopPropagation(); menuManager.toggle(menu); } });
  return el("div", { class: "dropdown" }, [btn, menu]);
}

function buildSectionDoc(section, sectionIndex, buildBody) {
  const wrap = el("div", { class: "section-doc", id: `section-doc-${section.id}` });
  const fixedMeta = FIXED_SECTIONS[sectionIndex] || FIXED_SECTIONS.find((fs) => fs.id === section.id);

  const header = el("div", { class: "section-doc-header section-doc-fixed-header" }, [
    el("span", { text: fixedMeta?.icon || "" }),
    el("span", { text: section.title }),
  ]);

  wrap.appendChild(header);
  wrap.appendChild(buildBody());
  return wrap;
}

function buildGroupBlock(section, group, startQ, groupIndex, groupCount) {
  const hasMatch = group.questions.some((ref) => questionMatchesSearchAndFilter(ref, group, section));
  const expanded = expandedGroupIds.has(group.id) || (!!searchTerm && hasMatch);
  const block = el("div", { class: "group-doc-block" + (expanded ? "" : " collapsed"), id: `group-doc-${group.id}` });

  const header = el("div", { class: "group-doc-header" }, [
    el("button", {
      type: "button",
      class: "section-doc-collapse-btn group-doc-collapse-btn" + (expanded ? "" : " collapsed"),
      "aria-label": expanded ? "Collapse group" : "Expand group",
      title: expanded ? "Collapse group" : "Expand group",
      text: "▾",
      onclick: () => toggleGroupExpanded(group.id),
    }),
    el("span", { class: "group-doc-type-badge", text: `${GROUP_TYPE_ICONS[group.type]} ${GROUP_TYPE_LABELS[group.type]}` }),
  ]);
  const titleInput = el("input", { type: "text", class: "group-doc-title-input", placeholder: "Untitled", value: group.title || "" });
  titleInput.addEventListener("input", (e) => { group.title = e.target.value; onDraftChanged({ structural: false, rerenderDoc: false }); });
  header.appendChild(titleInput);

  const menuItems = [];
  if (groupIndex > 0) menuItems.push({ label: "Move Up", onClick: () => moveGroupUp(section.id, group.id) });
  if (groupIndex < groupCount - 1) menuItems.push({ label: "Move Down", onClick: () => moveGroupDown(section.id, group.id) });
  menuItems.push(null);
  menuItems.push({ label: "Duplicate Group", onClick: () => duplicateGroup(section.id, group.id) });
  menuItems.push(null);
  GROUP_TYPES.filter((t) => t !== group.type).forEach((t) => {
    menuItems.push({ label: `Convert to ${GROUP_TYPE_LABELS[t]}`, onClick: () => convertGroupType(section.id, group.id, t) });
  });
  menuItems.push({ label: "Ungroup", onClick: () => ungroupGroup(section.id, group.id) });
  menuItems.push(null);
  menuItems.push({ label: "Delete Group", onClick: () => deleteGroup(section.id, group.id), danger: true });
  header.appendChild(buildThreeDotMenu(menuItems));

  block.appendChild(header);

  if (!expanded) {
    const endQ = startQ + group.questions.length - 1;
    block.appendChild(el("div", { class: "group-doc-collapsed-summary", text: `${group.questions.length} question${group.questions.length === 1 ? "" : "s"} · Q${startQ}${endQ > startQ ? `–Q${endQ}` : ""}` }));
    return block;
  }

  block.appendChild(buildGroupSharedFields(group));

  const questionsWrap = el("div", { class: "group-doc-questions" });
  group.questions.forEach((ref, idx) => {
    if (questionMatchesSearchAndFilter(ref, group, section)) {
      questionsWrap.appendChild(buildQuestionCard(ref, startQ + idx, section, group, false, idx, group.questions.length));
    }
  });
  block.appendChild(questionsWrap);

  block.appendChild(
    el("div", { class: "form-actions-row" }, [
      el("button", { type: "button", class: "btn btn-secondary btn-sm", text: "+ Add Question", disabled: group.questions.length >= MAX_GROUP_QUESTIONS ? "" : null, onclick: () => {
        if (group.questions.length >= MAX_GROUP_QUESTIONS) return;
        group.questions.push(createNewReference());
        onDraftChanged();
        requestAnimationFrame(() => scrollToGroup(group.id));
      } }),
    ])
  );

  return block;
}

function toggleGroupExpanded(groupId) {
  if (expandedGroupIds.has(groupId)) expandedGroupIds.delete(groupId);
  else expandedGroupIds.add(groupId);
  renderDoc();
}

function buildGroupSharedFields(group) {
  const wrap = el("div", { class: "group-doc-shared-fields" });

  if (group.type === "passage_group") {
    wrap.appendChild(sharedTextArea("Passage Text", group.passageText, (v) => { group.passageText = v; }));
    wrap.appendChild(optionalMediaField(group.id, group, "imageUrl", "image", "Image", "group"));
    wrap.appendChild(optionalMediaField(group.id, group, "audioUrl", "audio", "Audio"));
  } else if (group.type === "conversation_group") {
    wrap.appendChild(sharedTextInput("Speaker A Name", group.speakerAName, (v) => { group.speakerAName = v; }));
    wrap.appendChild(sharedTextArea("Speaker A Dialogue", group.speakerAText, (v) => { group.speakerAText = v; }));
    wrap.appendChild(sharedTextInput("Speaker B Name", group.speakerBName, (v) => { group.speakerBName = v; }));
    wrap.appendChild(sharedTextArea("Speaker B Dialogue", group.speakerBText, (v) => { group.speakerBText = v; }));
    wrap.appendChild(labeledMini("Audio (required)", buildUploadRowInner(group, "audioUrl", "audio")));
  } else if (group.type === "listening_group") {
    wrap.appendChild(labeledMini("Audio (required)", buildUploadRowInner(group, "audioUrl", "audio")));
  } else if (group.type === "image_group") {
    wrap.appendChild(labeledMini("Image (required)", buildUploadRowInner(group, "imageUrl", "image", "group")));
  }
  return wrap;
}

function sharedTextInput(label, value, onChange) {
  const input = el("input", { type: "text", class: "text-input text-input-sm", value: value || "" });
  input.addEventListener("input", (e) => { onChange(e.target.value); onDraftChanged({ structural: false, rerenderDoc: false }); });
  return labeledMini(label, input);
}
function sharedTextArea(label, value, onChange) {
  const ta = el("textarea", { class: "text-input" });
  ta.value = value || "";
  ta.addEventListener("input", (e) => { onChange(e.target.value); onDraftChanged({ structural: false, rerenderDoc: false }); });
  return labeledMini(label, ta);
}
function labeledMini(label, control) {
  return el("div", { class: "field-group" }, [el("label", { class: "field-label", text: label }), control]);
}

/* =========================================================
   PROGRESSIVE DISCLOSURE
   ========================================================= */
function reveal(key) {
  revealedFields.add(key);
  renderDoc();
}

function optionalMediaField(ownerId, obj, field, accept, label, size = "compact") {
  const key = `${ownerId}:${field}`;
  if (obj[field] || revealedFields.has(key)) {
    return labeledMini(`${label} (optional)`, buildUploadRowInner(obj, field, accept, size));
  }
  return el("button", { type: "button", class: "btn btn-ghost btn-sm add-field-btn", text: `+ Add ${label}`, onclick: () => reveal(key) });
}

function optionalExplanationField(ref, entry) {
  const key = `${ref.id}:explanation`;
  if (entry.explanation || revealedFields.has(key)) {
    const ta = el("textarea", { class: "text-input", placeholder: "Explanation" });
    ta.value = entry.explanation || "";
    ta.style.minHeight = "50px";
    ta.addEventListener("input", (e) => saveQuestionField(ref, { explanation: e.target.value }));
    return labeledMini("Explanation", ta);
  }
  return el("button", { type: "button", class: "btn btn-ghost btn-sm add-field-btn", text: "+ Add Explanation", onclick: () => reveal(key) });
}

function buildUploadRowInner(obj, field, accept, size = "compact") {
  const row = el("div", { class: "upload-row" });
  const input = el("input", {
    type: "file", accept: accept === "audio" ? "audio/*" : "image/*",
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      obj[field] = await readFileAsDataUrl(file);
      onDraftChanged();
    },
  });
  row.appendChild(input);
  if (obj[field]) {
    row.appendChild(accept === "audio" ? el("audio", { controls: "", src: obj[field], style: "height:32px;" }) : el("img", { class: size === "group" ? "upload-preview upload-preview-group" : "upload-preview", src: obj[field], alt: "Uploaded preview" }));
    row.appendChild(el("button", { type: "button", class: "upload-clear-btn", text: "Remove", onclick: () => { obj[field] = null; onDraftChanged(); } }));
  }
  return row;
}

/* =========================================================
   QUESTION CARD — checkbox (selection) + minimal header + ⋮
   ========================================================= */
function buildQuestionCard(ref, orderNumber, section, group, isStandalone, indexInGroup, groupSize) {
  const entry = resolveRef(ref);
  const complete = isQuestionComplete(entry);
  const selected = selectedIds.has(ref.id);
  const card = el("div", {
    class: "question-doc-card" + (entry.bookmarked ? " bookmarked" : "") + (selected ? " selected" : "") + (entry.required ? " required-flag" : ""),
    id: `question-doc-${ref.id}`,
  });

  const checkbox = el("input", { type: "checkbox", checked: selected ? "" : null });
  checkbox.addEventListener("click", (e) => handleSelectionClick(ref.id, e));
  card.appendChild(el("div", { class: "question-doc-card-select" }, [checkbox]));

  const body = el("div", { class: "question-doc-body" });

  const topRow = el("div", { class: "question-doc-top-row" }, [el("span", { class: "question-doc-badge", text: `Q${orderNumber}` })]);
  if (entry.required) topRow.appendChild(el("span", { class: "question-doc-required-tag", text: "Required" }));
  if (!complete) topRow.appendChild(el("span", { class: "question-doc-incomplete-flag", text: "Incomplete" }));

  const actions = el("div", { class: "question-doc-icon-actions" }, [
    iconBtn(entry.bookmarked ? "★" : "☆", "Bookmark", () => toggleBookmark(ref.id)),
    iconBtn("⧉", "Duplicate", () => duplicateQuestion(ref.id)),
  ]);
  // One-click Move/Merge — visible buttons instead of burying these behind
  // the ⋮ menu, since they're the most common actions on a standalone
  // question. Still conditionally shown/hidden exactly like their old
  // ⋮-menu-item counterparts (no Move Up on the first item, etc).
  if (indexInGroup > 0) actions.appendChild(iconBtn("↑", "Move Up", () => moveQuestionUp(section.id, group.id, ref.id)));
  if (indexInGroup < groupSize - 1) actions.appendChild(iconBtn("↓", "Move Down", () => moveQuestionDown(section.id, group.id, ref.id)));
  if (isStandalone) {
    if (indexInGroup > 0) actions.appendChild(iconBtn("Merge↑", "Merge with Previous", () => mergeWithPrevious(section.id, group.id), "icon-btn-wide"));
    if (indexInGroup < groupSize - 1) actions.appendChild(iconBtn("Merge↓", "Merge with Next", () => mergeWithNext(section.id, group.id), "icon-btn-wide"));
  }

  const menuItems = [];
  if (isStandalone) {
    GROUP_TYPES.forEach((t) => {
      menuItems.push({ label: `Convert to ${GROUP_TYPE_LABELS[t]}`, onClick: () => convertStandaloneToGroup(section.id, group.id, t) });
    });
    menuItems.push(null);
  }
  menuItems.push(null);
  FIXED_SECTIONS.filter((fs) => fs.id !== section.id).forEach((fs) => {
    menuItems.push({ label: `Move To ${fs.icon} ${fs.title}`, onClick: () => moveQuestionToSection(ref.id, fs.id) });
  });
  menuItems.push(null);
  menuItems.push({ label: entry.required ? "Required OFF" : "Required ON", onClick: () => { saveQuestionField(ref, { required: !entry.required }); renderDoc(); } });
  menuItems.push(null);
  menuItems.push({ label: "Delete", onClick: () => removeQuestionFromTest(ref.id), danger: true });
  actions.appendChild(buildThreeDotMenu(menuItems));
  topRow.appendChild(actions);
  body.appendChild(topRow);

  const questionTa = el("textarea", { class: "text-input question-textarea", placeholder: "Question text" });
  questionTa.value = entry.question || "";
  const autoGrowTa = (elm) => { elm.style.height = "auto"; elm.style.height = `${elm.scrollHeight}px`; };
  questionTa.addEventListener("focus", () => setPreviewTarget(section.id, group.id));
  questionTa.addEventListener("input", (e) => { saveQuestionField(ref, { question: e.target.value }); autoGrowTa(e.target); renderSidebarDebounced(); renderPreview(); renderProgressBarDebounced(); });
  body.appendChild(questionTa);
  requestAnimationFrame(() => autoGrowTa(questionTa));

  if (isStandalone) {
    body.appendChild(optionalMediaField(ref.id, group, "imageUrl", "image", "Image"));
    body.appendChild(optionalMediaField(ref.id, group, "audioUrl", "audio", "Audio"));
  }

  body.appendChild(buildOptionsEditor(ref, entry));
  body.appendChild(optionalExplanationField(ref, entry));

  const marksInput = el("input", { type: "number", class: "text-input", style: "max-width:120px;", value: entry.marks ?? 1 });
  marksInput.addEventListener("input", (e) => { saveQuestionField(ref, { marks: e.target.value === "" ? null : Number(e.target.value) }); renderDocDebounced(); renderProgressBarDebounced(); });
  body.appendChild(labeledMini("Marks", marksInput));

  card.appendChild(body);

  bindLongPress(topRow.querySelector(".question-doc-badge"), () => {
    if (!selectedIds.has(ref.id)) {
      selectedIds.add(ref.id);
      updateSelectionToolbar();
      renderDoc();
    }
  });

  return card;
}

function bindLongPress(targetEl, onLongPress) {
  if (!targetEl) return;
  let timer = null;
  const start = () => { timer = setTimeout(onLongPress, LONG_PRESS_MS); };
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  targetEl.addEventListener("touchstart", start, { passive: true });
  targetEl.addEventListener("touchend", cancel);
  targetEl.addEventListener("touchmove", cancel);
  targetEl.addEventListener("touchcancel", cancel);
}

const renderSidebarDebounced = debounce(() => renderSidebar(), 400);
const renderDocDebounced = debounce(() => renderDoc(), 600);
const renderProgressBarDebounced = debounce(() => renderProgressBar(), 400);

function iconBtn(glyph, ariaLabel, onClick, extraClass = "") {
  return el("button", { type: "button", class: `icon-btn icon-btn-xs ${extraClass}`.trim(), "aria-label": ariaLabel, title: ariaLabel, text: glyph, onclick: onClick });
}

/** Renders only as many option rows as actually have content (plus any
 * slots the admin has explicitly asked to add via "+ Add option") — never
 * force-pads to 4, and never renders a blank row for an empty stored
 * slot, per the "don't show empty options" rule. The underlying stored
 * array is never truncated or auto-padded; a new slot only ever gets
 * written when the admin actually types into it. */
function buildOptionsEditor(ref, entry) {
  const wrap = el("div", { class: "options-editor" });
  const letters = ["A", "B", "C", "D"];
  const stored = Array.isArray(entry.options) ? entry.options : [];

  let filledCount = 0;
  stored.forEach((v, i) => { if ((v || "").trim() !== "") filledCount = i + 1; });
  const extraSlots = revealedOptionSlots.get(ref.id) || 0;
  const visibleCount = Math.min(4, Math.max(2, filledCount) + extraSlots);

  for (let idx = 0; idx < visibleCount; idx++) {
    const letter = letters[idx];
    const value = stored[idx] || "";
    const radio = el("input", {
      type: "radio", name: `correct-${ref.id}`,
      checked: entry.correctOption && entry.correctOption === value && value !== "" ? "" : null,
      onchange: () => { saveQuestionField(ref, { correctOption: value }); entry.correctOption = value; renderPreview(); renderProgressBarDebounced(); },
    });
    const input = el("textarea", { class: "text-input option-input", placeholder: `Option ${letter}`, rows: "1" });
    input.value = value;
    const autoGrow = (elm) => { elm.style.height = "auto"; elm.style.height = `${elm.scrollHeight}px`; };
    input.addEventListener("input", (e) => {
      const oldValue = stored[idx] || "";
      const newOptions = [...stored];
      while (newOptions.length <= idx) newOptions.push("");
      newOptions[idx] = e.target.value;
      const patch = { options: newOptions };
      if (entry.correctOption === oldValue && oldValue !== "") patch.correctOption = e.target.value;
      saveQuestionField(ref, patch);
      stored[idx] = e.target.value;
      entry.options = newOptions;
      if (entry.correctOption === oldValue && oldValue !== "") entry.correctOption = e.target.value;
      autoGrow(e.target);
      renderPreview();
      renderProgressBarDebounced();
    });
    const deleteBtn = el("button", {
      type: "button", class: "icon-btn icon-btn-xs option-delete-btn", "aria-label": `Delete option ${letter}`, title: "Delete option", text: "✕",
      onclick: () => {
        const newOptions = [...stored];
        newOptions.splice(idx, 1);
        const patch = { options: newOptions };
        if (entry.correctOption === value && value !== "") patch.correctOption = null;
        saveQuestionField(ref, patch);
        entry.options = newOptions;
        if (entry.correctOption === value && value !== "") entry.correctOption = null;
        renderDoc();
        renderPreview();
        renderProgressBarDebounced();
      },
    });
    wrap.appendChild(el("div", { class: "option-row" }, [radio, el("span", { class: "option-letter", text: letter }), input, deleteBtn]));
    requestAnimationFrame(() => autoGrow(input));
  }

  if (visibleCount < 4) {
    wrap.appendChild(el("button", {
      type: "button", class: "btn btn-ghost btn-sm add-field-btn add-option-btn", text: "+ Add option",
      onclick: () => { revealedOptionSlots.set(ref.id, extraSlots + 1); renderDoc(); },
    }));
  }
  return wrap;
}

/* =========================================================
   LIVE PREVIEW
   ========================================================= */
function setPreviewTarget(sectionId, groupId) {
  if (previewTarget && previewTarget.sectionId === sectionId && previewTarget.groupId === groupId) return;
  menuManager.closeAll(); // focusing a different question counts as "question change"
  previewTarget = { sectionId, groupId };
  renderPreview();
}

function renderPreview() {
  els.previewPaneContent.innerHTML = "";
  if (!previewTarget) {
    els.previewPaneContent.appendChild(el("div", { class: "empty-state" }, [el("h2", { text: draft.title || "Untitled Test" }), el("p", { text: "Click into a question to preview it." })]));
    return;
  }
  const group = findGroup(previewTarget.sectionId, previewTarget.groupId);
  if (!group) return;
  renderGroupPreview(els.previewPaneContent, group, { startOrder: computeStartOrderForGroup(group) });
}

function computeStartOrderForGroup(targetGroup) {
  let order = 0;
  for (const section of draft.sections) {
    for (const group of section.groups) {
      if (group.id === targetGroup.id) return order + 1;
      order += group.questions.length;
    }
  }
  return order + 1;
}

/* =========================================================
   EXPORT / VALIDATION
   ========================================================= */
async function handleExport() {
  const errors = validateDraft(draft);
  if (errors.length > 0) {
    showValidationErrors(errors.map((e) => e.message));
    return;
  }
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = "Checking media…";
  const broken = await checkBrokenMedia(draft);
  els.exportBtn.disabled = false;
  els.exportBtn.textContent = "Export JSON";

  if (broken.length > 0) {
    showValidationErrors(broken.map((b) => `Unreachable ${b.kind}: ${b.url}`));
    return;
  }

  downloadExport(draft);
  showToast("Exported Selected_Mock_Tests.json", "success");
}

/**
 * Publishes the current draft to Supabase's `tests` table so it appears
 * on the student dashboard (once the admin has granted access — see
 * admin/users.html). Requires the operator to be signed in with a
 * Google account that's in public.admins — see adminAuth.js. This is a
 * SEPARATE action from Export JSON (which is unaffected, still a pure
 * local download); publishing does not require exporting first, and
 * vice versa.
 */
async function handlePublish() {
  const errors = validateDraft(draft);
  if (errors.length > 0) {
    showValidationErrors(errors.map((e) => e.message));
    return;
  }

  const { getSession, getProfile, isAdmin, signInWithGoogle } = await import("../../js/auth.js?v=4");
  const session = await getSession();
  if (!session) {
    const wantsSignIn = await confirmDialog(
      "Publishing to Supabase requires signing in with your admin Google account. Sign in now?",
      { confirmLabel: "Sign in with Google" }
    );
    if (wantsSignIn) await signInWithGoogle(window.location.pathname + window.location.search);
    return;
  }
  const [profile, admin] = await Promise.all([getProfile(), isAdmin()]);
  if (!admin) {
    showToast(`Signed in as ${profile?.email || "unknown"}, but that account isn't an admin — see SETUP_SUPABASE_AUTH.md §6.`, "error");
    return;
  }

  els.publishBtn.disabled = true;
  els.publishBtn.textContent = "Publishing…";
  try {
    const { publishDraftToSupabase } = await import("./publish.js?v=4");
    await publishDraftToSupabase(draft, "published", profile.id);
    showToast("Published — visible to authorized users on the dashboard.", "success");
  } catch (err) {
    console.error("Publish failed", err);
    showToast(`Publish failed: ${err.message || err}`, "error");
  } finally {
    els.publishBtn.disabled = false;
    els.publishBtn.textContent = "Publish to Supabase";
  }
}

/** "Test as User" — writes the current (unsaved-to-a-file, but auto-saved-to-localStorage) draft as a real exported document into a well-known localStorage key, then opens the real exam.html against it via ?adminPreview=1 (see loader.js's fetchExport override). This runs the EXACT same student code path — navigation, answering, images/audio, required-question enforcement, submission, and the real JFT result screen — not a separate preview implementation, so it actually catches problems before publishing. Opens in a new tab so the admin doesn't lose their place in the editor. */
function handleTestAsUser() {
  const s = computeScoreSummary();
  if (s.totalQuestions === 0) {
    showToast("Add at least one question before using Test as User.", "error");
    return;
  }
  persist();
  const exported = buildExportDocument(draft);
  try {
    localStorage.setItem("nmt_admin_preview_test_v1", JSON.stringify(exported));
  } catch (err) {
    showToast("Could not start Test as User — local storage error.", "error");
    return;
  }
  // Always a fresh attempt — resuming a stale prior test-mode run would be confusing when the admin is iterating on the test between attempts.
  localStorage.removeItem("nmt_session_v1");
  window.open(`../exam.html?testId=${encodeURIComponent(draft.id)}&adminPreview=1`, "_blank");
}

function showValidationErrors(messages) {
  els.validationErrorList.innerHTML = "";
  messages.forEach((msg) => els.validationErrorList.appendChild(el("li", { text: msg })));
  els.validationModal.showModal();
}

/* =========================================================
   MENU MANAGER — single global authority over every non-modal
   popup (⋮ menus, "+ New Group" dropdown, Filters dropdown,
   Select panel). Guarantees: nothing is ever open except
   through open()/toggle(), and open()/toggle() always close
   every other popup first, so at most one is ever visible.
   Dialogs (<dialog>.showModal()) are native top-layer and
   handled separately (see openMoveDialog/openMergeDialog/
   openConvertDialog and the Escape/backdrop-click wiring
   below) — but every dialog opener also calls closeAll() so
   a stray dropdown never sits open behind a modal.
   ========================================================= */
const menuManager = (() => {
  let openMenu = null;

  /** Called at popup-creation time — guarantees the popup starts closed, independent of whatever the `hidden` attribute happened to be set to when the element was built. */
  function register(menuEl) {
    menuEl.hidden = true;
    return menuEl;
  }
  function isOpen(menuEl) {
    return !!menuEl && !menuEl.hidden;
  }
  function open(menuEl) {
    if (!menuEl || openMenu === menuEl) return;
    closeAll();
    menuEl.hidden = false;
    openMenu = menuEl;
  }
  function close(menuEl) {
    if (!menuEl) return;
    menuEl.hidden = true;
    if (openMenu === menuEl) openMenu = null;
  }
  /** Closes every popup currently in the DOM, not just the one this manager thinks is open — a live query rather than a tracked list, since popups here are rebuilt on every render and stale references would otherwise leak. */
  function closeAll() {
    document.querySelectorAll(".dropdown-menu, .select-panel").forEach((m) => { m.hidden = true; });
    openMenu = null;
  }
  function toggle(menuEl) {
    if (isOpen(menuEl)) close(menuEl);
    else open(menuEl);
  }
  return { register, open, close, closeAll, toggle, isOpen };
})();

/* =========================================================
   MOBILE PANELS
   ========================================================= */
function closeMobilePanels() {
  els.editorSidebar.classList.remove("open");
  setMobileView("edit");
}

/** Below 900px, Edit and Preview are two full-width swaps of the same content area (not an overlay) — this is the one place that toggles which is showing. */
function setMobileView(view) {
  document.querySelectorAll(".mobile-ep-tab").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelector(".editor-layout")?.classList.toggle("mobile-showing-preview", view === "preview");
}

/* =========================================================
   EVENT BINDING
   ========================================================= */
function bindEvents() {
  els.testTitleInput.addEventListener("input", (e) => {
    draft.title = e.target.value;
    onDraftChanged({ structural: false, rerenderSidebar: false, rerenderDoc: false });
  });

  els.settingsNavBtn.addEventListener("click", () => { persist(); window.location.href = "settings.html"; });

  els.outlineTabBtn.addEventListener("click", () => switchSidebarTab("outline"));
  els.bankTabBtn.addEventListener("click", () => switchSidebarTab("bank"));
  els.bankSearchInput.addEventListener("input", debounce((e) => { bankSearchTerm = e.target.value.trim(); renderBankPanel(); }, 150));

  els.sidebarSearchInput.addEventListener("input", debounce((e) => { searchTerm = e.target.value.trim(); renderSidebar(); renderDoc(); }, 150));

  els.filterChipRow.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      els.filterChipRow.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeFilter = chip.dataset.filter;
      renderSidebar();
      renderDoc();
      els.filterMenu.hidden = true;
    });
  });

  els.selectPanelBtn.addEventListener("click", (e) => { e.stopPropagation(); menuManager.toggle(els.selectPanel); });
  els.filterMenuBtn.addEventListener("click", (e) => { e.stopPropagation(); menuManager.toggle(els.filterMenu); });
  els.selectAllBtn.addEventListener("click", () => { selectAllQuestions(); menuManager.closeAll(); });
  els.selectSectionBtn.addEventListener("click", () => { selectCurrentSection(); menuManager.closeAll(); });
  els.selectGroupBtn.addEventListener("click", () => { selectCurrentGroup(); menuManager.closeAll(); });
  els.invertSelectionBtn.addEventListener("click", () => { invertSelection(); menuManager.closeAll(); });
  els.clearSelectionMenuBtn.addEventListener("click", () => { clearSelection(); menuManager.closeAll(); });

  els.selRequiredOnBtn.addEventListener("click", () => bulkRequired(true));
  els.selRequiredOffBtn.addEventListener("click", () => bulkRequired(false));
  els.selBookmarkBtn.addEventListener("click", () => bulkBookmark(true));
  els.selUnbookmarkBtn.addEventListener("click", () => bulkBookmark(false));
  els.selDuplicateBtn.addEventListener("click", bulkDuplicate);
  els.selMoveBtn.addEventListener("click", openMoveDialog);
  els.selMergeBtn.addEventListener("click", openMergeDialog);
  els.selConvertBtn.addEventListener("click", openConvertDialog);
  els.selUngroupBtn.addEventListener("click", bulkUngroup);
  els.selDeleteBtn.addEventListener("click", bulkDelete);
  els.selCancelBtn.addEventListener("click", clearSelection);

  els.moveDialogCancelBtn.addEventListener("click", () => els.moveDialog.close());
  els.moveDialogConfirmBtn.addEventListener("click", () => {
    if (!moveDialogSelectedSectionId) return;
    bulkMoveToSection(moveDialogSelectedSectionId);
    els.moveDialog.close();
  });

  els.mergeDialogCancelBtn.addEventListener("click", () => els.mergeDialog.close());
  els.mergeDialogConfirmBtn.addEventListener("click", () => {
    if (!mergeDialogSelectedType) return;
    bulkMerge(mergeDialogSelectedType);
    els.mergeDialog.close();
  });

  els.convertDialogCancelBtn.addEventListener("click", () => els.convertDialog.close());

  els.calculateScoresBtn.addEventListener("click", () => {
    menuManager.closeAll();
    renderScoresModal();
    els.scoresDialog.showModal();
  });
  els.scoresRecalculateBtn.addEventListener("click", renderScoresModal);
  els.scoresCloseBtn.addEventListener("click", () => els.scoresDialog.close());

  els.resultSettingsBtn.addEventListener("click", () => {
    menuManager.closeAll();
    renderResultSettingsDialog();
    els.resultSettingsDialog.showModal();
  });
  els.resultSettingsCloseBtn.addEventListener("click", () => els.resultSettingsDialog.close());

  els.securitySettingsBtn.addEventListener("click", () => {
    menuManager.closeAll();
    renderSecuritySettingsDialog();
    els.securitySettingsDialog.showModal();
  });
  els.securitySettingsCloseBtn.addEventListener("click", () => els.securitySettingsDialog.close());

  els.exportBtn.addEventListener("click", handleExport);
  els.publishBtn.addEventListener("click", handlePublish);
  els.closeValidationBtn.addEventListener("click", () => els.validationModal.close());
  els.testAsUserBtn.addEventListener("click", handleTestAsUser);
  els.previewFullBtn.addEventListener("click", () => { persist(); window.location.href = `preview.html?id=${encodeURIComponent(draft.id)}`; });

  els.undoBtn.addEventListener("click", undo);
  els.redoBtn.addEventListener("click", redo);
  document.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing) {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) && !typing) {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing) {
      e.preventDefault();
      selectAllQuestions();
    } else if (e.key === "Escape") {
      const hadOpenPopup = document.querySelector(".dropdown-menu:not([hidden]), .select-panel:not([hidden])") !== null;
      const openDialogs = [els.moveDialog, els.mergeDialog, els.convertDialog, els.scoresDialog, els.resultSettingsDialog, els.securitySettingsDialog, els.validationModal].filter((d) => d.open);
      menuManager.closeAll();
      openDialogs.forEach((d) => d.close()); // defensive — native <dialog> already closes on Escape by itself
      if (!hadOpenPopup && openDialogs.length === 0 && isSelectionMode()) clearSelection();
    }
  });

  // mousedown/pointerdown/touchstart (not click) so a popup closes at the
  // very start of an outside interaction, before any click-through side
  // effect on whatever's underneath it — same handler on all three since
  // it's idempotent (closeAll firing more than once for one tap is harmless).
  const handleOutsideInteraction = (e) => {
    if (!e.target.closest(".dropdown") && !e.target.closest(".popover-anchor")) menuManager.closeAll();
  };
  document.addEventListener("mousedown", handleOutsideInteraction);
  document.addEventListener("pointerdown", handleOutsideInteraction);
  document.addEventListener("touchstart", handleOutsideInteraction, { passive: true });

  // Scrolling ANY scrollable region (center panel, sidebar tree, preview
  // pane) closes popups too — scroll events don't bubble, so this listens
  // in the capture phase on document, which does catch them regardless of
  // which descendant actually scrolled.
  document.addEventListener("scroll", () => menuManager.closeAll(), true);
  window.addEventListener("resize", () => menuManager.closeAll());

  // Clicking a dialog's own backdrop area (outside .modal-body, inside the
  // <dialog> box itself) closes it — native <dialog> has no built-in
  // click-outside-to-close, only Escape.
  [els.moveDialog, els.mergeDialog, els.convertDialog, els.scoresDialog, els.resultSettingsDialog, els.securitySettingsDialog].forEach((dialogEl) => {
    dialogEl.addEventListener("click", (e) => { if (e.target === dialogEl) dialogEl.close(); });
  });

  els.mobileSidebarToggle.addEventListener("click", () => { els.editorSidebar.classList.toggle("open"); });
  document.querySelectorAll(".mobile-ep-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMobileView(tab.dataset.view));
  });

  window.addEventListener("beforeunload", () => persist());
}

init();
