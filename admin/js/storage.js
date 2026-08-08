/**
 * storage.js (admin)
 * All localStorage access for the admin panel: the list of saved test
 * drafts ("Recent Tests"), the currently-open draft (autosaved on every
 * edit), and admin-only settings. Namespaced separately from the student
 * app's own storage keys (nmt_session_v1 / nmt_last_result_v1) so the two
 * apps never collide even though they share an origin on GitHub Pages.
 */

const TESTS_INDEX_KEY = "nmt_admin_tests_v1"; // { [testId]: draftSummary }
const ACTIVE_DRAFT_PREFIX = "nmt_admin_draft_"; // + testId -> full draft object
const SETTINGS_KEY = "nmt_admin_settings_v1";

/** Read the full index of saved drafts (id -> lightweight summary for the dashboard list). */
export function listDrafts() {
  try {
    const raw = localStorage.getItem(TESTS_INDEX_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("storage.listDrafts failed", err);
    return {};
  }
}

/** Save (create or update) a full draft, and refresh its dashboard summary entry. */
export function saveDraft(draft) {
  try {
    localStorage.setItem(ACTIVE_DRAFT_PREFIX + draft.id, JSON.stringify(draft));

    const index = listDrafts();
    index[draft.id] = {
      id: draft.id,
      title: draft.title || "Untitled Test",
      category: draft.categoryName || "",
      questionCount: countQuestions(draft),
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(TESTS_INDEX_KEY, JSON.stringify(index));
    return true;
  } catch (err) {
    console.error("storage.saveDraft failed", err);
    return false;
  }
}

function countQuestions(draft) {
  if (!Array.isArray(draft.sections)) return 0;
  return draft.sections.reduce((sum, section) => {
    const groups = Array.isArray(section.groups) ? section.groups : [];
    return sum + groups.reduce((gSum, group) => gSum + (Array.isArray(group.questions) ? group.questions.length : 0), 0);
  }, 0);
}

/** Load one full draft by id. */
export function loadDraft(id) {
  try {
    const raw = localStorage.getItem(ACTIVE_DRAFT_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("storage.loadDraft failed", err);
    return null;
  }
}

/** Delete a draft entirely (both the full record and its dashboard summary). */
export function deleteDraft(id) {
  localStorage.removeItem(ACTIVE_DRAFT_PREFIX + id);
  const index = listDrafts();
  delete index[id];
  localStorage.setItem(TESTS_INDEX_KEY, JSON.stringify(index));
}

/** Remember which draft id the editor should reopen (used by the "last active" link). */
export function setLastOpenedDraftId(id) {
  localStorage.setItem("nmt_admin_last_opened", id);
}
export function getLastOpenedDraftId() {
  return localStorage.getItem("nmt_admin_last_opened");
}

/** Admin-only settings (currently just placeholders for future preferences). */
export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { autoSaveEnabled: true };
  } catch (err) {
    return { autoSaveEnabled: true };
  }
}
export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
