/**
 * exam.js
 * Controller for exam.html. Navigation now moves between GROUPS (test.pages),
 * not individual questions — each group can render 1-5 questions sharing a
 * passage/conversation/image/audio. The palette still lists every question
 * individually (via test.questionIndex) and jumping to one switches to its
 * group's page, then scrolls to that question's anchor within it.
 */
import { loadTest, findQuestionLocation } from "./loader.js?v=8";
import { ExamTimer, getTimerState, formatTime } from "./timer.js?v=5";
import { renderPalette, updatePaletteState, computeSummary, computeGroupCompletion } from "./palette.js?v=3";
import { bindArrowKeyNavigation, resolveJumpQuestionId, bindSwipeToClose } from "./navigation.js?v=3";
import { saveSession, loadSession, clearSession, saveResult, startOrResumeAttempt, submitAttemptServerSide } from "./storage.js?v=7";
import { requireAuth } from "./auth.js?v=4";
import { hidePageLoader, initThemeToggle, debounce, initPinchZoom } from "./utils.js?v=6";
import { buildSharedBlock, buildQuestionBlock } from "./groupRenderer.js?v=8";

import {
  lockdownInputSurface,
  blockKeyboardShortcuts,
  initFullscreenGuard,
  startDevToolsHeuristic,
  initVisibilityGuard,
} from "./security.js?v=5";

const els = {
  examTestTitle: document.getElementById("examTestTitle"),
  examModeIndicator: document.getElementById("examModeIndicator"),
  examStartNoticeModal: document.getElementById("examStartNoticeModal"),
  examStartNoticeList: document.getElementById("examStartNoticeList"),
  startExamBtn: document.getElementById("startExamBtn"),
  securityToastContainer: document.getElementById("securityToastContainer"),
  adminTestModeBanner: document.getElementById("adminTestModeBanner"),
  examProgressText: document.getElementById("examProgressText"),
  progressBarFill: document.getElementById("progressBarFill"),
  timerDisplay: document.getElementById("timerDisplay"),
  timerText: document.getElementById("timerText"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),
  examDarkModeToggle: document.getElementById("examDarkModeToggle"),

  sectionBanner: document.getElementById("sectionBanner"),
  sectionBannerIndex: document.getElementById("sectionBannerIndex"),
  sectionBannerTitle: document.getElementById("sectionBannerTitle"),
  examSectionProgress: document.getElementById("examSectionProgress"),

  groupContent: document.getElementById("groupContent"),

  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  nextBtnLabel: document.getElementById("nextBtnLabel"),

  paletteToggleBtn: document.getElementById("paletteToggleBtn"),
  sheetBackdrop: document.getElementById("sheetBackdrop"),
  paletteSheet: document.getElementById("paletteSheet"),
  sheetDragHandle: document.getElementById("sheetDragHandle"),
  paletteGrid: document.getElementById("paletteGrid"),
  questionSearchInput: document.getElementById("questionSearchInput"),
  summaryAnswered: document.getElementById("summaryAnswered"),
  summaryUnanswered: document.getElementById("summaryUnanswered"),
  summaryBookmarked: document.getElementById("summaryBookmarked"),

  submitConfirmModal: document.getElementById("submitConfirmModal"),
  submitFailedModal: document.getElementById("submitFailedModal"),
  submitFailedMessage: document.getElementById("submitFailedMessage"),
  retrySubmitBtn: document.getElementById("retrySubmitBtn"),
  confirmAnswered: document.getElementById("confirmAnswered"),
  confirmUnanswered: document.getElementById("confirmUnanswered"),
  confirmBookmarked: document.getElementById("confirmBookmarked"),
  requiredWarning: document.getElementById("requiredWarning"),
  requiredWarningList: document.getElementById("requiredWarningList"),
  cancelSubmitBtn: document.getElementById("cancelSubmitBtn"),
  confirmSubmitBtn: document.getElementById("confirmSubmitBtn"),

  sectionCompleteModal: document.getElementById("sectionCompleteModal"),
  sectionCompleteName: document.getElementById("sectionCompleteName"),
  stayInSectionBtn: document.getElementById("stayInSectionBtn"),
  continueToNextSectionBtn: document.getElementById("continueToNextSectionBtn"),

  sectionTransitionOverlay: document.getElementById("sectionTransitionOverlay"),
  sectionTransitionFromName: document.getElementById("sectionTransitionFromName"),
  sectionTransitionLabel: document.getElementById("sectionTransitionLabel"),
  sectionTransitionArrowRow: document.getElementById("sectionTransitionArrowRow"),
  sectionTransitionToName: document.getElementById("sectionTransitionToName"),

  examFullscreenModal: document.getElementById("examFullscreenModal"),
  examFullscreenText: document.getElementById("examFullscreenText"),
  examFullscreenError: document.getElementById("examFullscreenError"),
  examFullscreenBtn: document.getElementById("examFullscreenBtn"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomLevelText: document.getElementById("zoomLevelText"),
  devtoolsWarningModal: document.getElementById("devtoolsWarningModal"),
  devtoolsWarningText: document.getElementById("devtoolsWarningText"),
  devtoolsWarningDismissBtn: document.getElementById("devtoolsWarningDismissBtn"),
  visibilityWarningModal: document.getElementById("visibilityWarningModal"),
  visibilityWarningText: document.getElementById("visibilityWarningText"),
  visibilityWarningDismissBtn: document.getElementById("visibilityWarningDismissBtn"),
};

let test = null;
let state = {
  studentName: "",
  currentPageIndex: 0,
  currentSectionIndex: 0,
  completedSections: [],
  securityEvents: [], // [{type, timestamp}] — see logSecurityEvent // section indices the user has permanently finished, in order — always [0..currentSectionIndex-1] since sections must complete strictly in order, but stored explicitly (not derived) per spec
  answers: {}, // questionId -> selected option string
  bookmarks: [], // questionId[]
  visited: [], // questionId[]
  startedAt: null,
  remainingSeconds: 0,
  attemptId: null, // Supabase test_attempts row id, set once startOrResumeAttempt() resolves
};
let timer = null;
let fullscreenGuard = null;
let pendingFullscreenIsInitialStart = false;
let lastRenderedSectionIndex = -1;
let backButtonTrapActive = false;
let pendingRetryIsAutoSubmit = false; // set by showSubmitFailedModal(), read by the retry button's handler
let allowUnload = false; // set true only right before an intentional post-finish navigation — see the beforeunload handler at the bottom of this file
const autoSaveScheduled = debounce(persistSession, 400);

async function init() {
  initThemeToggle(els.examDarkModeToggle);
  const params = new URLSearchParams(window.location.search);
  const isDraftPreview = params.get("adminPreview") === "1"; // local unsaved draft, via editor.js's "Test as User"
  const isLivePreview = params.get("preview") === "1"; // a real, already-published/draft Supabase test, via admin/tests.html's "Preview"
  const previewAsEmail = params.get("previewAs"); // display-only — see admin/js/tests.js; never changes what data loads or who an attempt is recorded under
  const isAnyAdminPreview = isDraftPreview || isLivePreview;

  els.adminTestModeBanner.hidden = !isAnyAdminPreview;
  if (isAnyAdminPreview) {
    els.adminTestModeBanner.textContent = previewAsEmail
      ? `ADMIN PREVIEW — viewing as ${previewAsEmail} (this attempt is still recorded under YOUR admin account, not theirs)`
      : "ADMIN PREVIEW — this attempt is not saved as a real student result";
  }

  // Local-draft preview reads from localStorage (see loader.js) and was
  // never gated by real login (it predates Supabase entirely — see the
  // project's continuation doc). Live preview of a real Supabase test
  // DOES require a real admin session — RLS's is_admin() is what lets
  // an admin load a draft/unpublished test that ordinary RLS would
  // otherwise hide, so there's no separate "is this person an admin"
  // check needed here beyond the normal signed-in check.
  const profile = isDraftPreview ? null : await requireAuth();
  if (!isDraftPreview && !profile) return; // requireAuth() already redirected

  const testId = params.get("testId");

  try {
    test = await loadTest(testId);
  } catch (err) {
    console.error(err);
    els.groupContent.innerHTML = `<p style="text-align:center;padding:40px;">Could not load the test. Please return to the dashboard and try again.</p>`;
    hidePageLoader();
    return;
  }

  // Awaited (not fire-and-forget) specifically so we know BEFORE
  // deciding whether to trust any local session: `resumed: true` means
  // a real, still-open attempt exists server-side; `resumed: false`
  // means this is a genuinely fresh start (first attempt, OR the
  // previous one was already submitted) — see storage.js's updated
  // startOrResumeAttempt() doc-comment. This is what makes clicking a
  // shared/direct exam link always start at question 1 on a retry,
  // instead of silently resuming stale localStorage progress from a
  // completed or long-abandoned attempt.
  let attemptResumed = false;
  if (profile) {
    // testId here is the URL param (the REAL Supabase UUID) — NOT
    // test.id, which is content.id, embedded at publish time from the
    // local editor draft's own id and never a valid UUID (see
    // export.js). Passing test.id here was a real bug fixed in an
    // earlier session; kept as testId deliberately.
    const attempt = await startOrResumeAttempt(profile.id, testId, { isAdminPreview: isAnyAdminPreview });
    state.attemptId = attempt.id;
    attemptResumed = attempt.resumed;
  }

  const existingSession = loadSession();
  // Draft preview has no server-side attempt concept at all (never
  // touches Supabase) — local-session resume there is unchanged, purely
  // based on whether a matching local draft session exists, which is
  // genuinely useful for an admin iterating on their own draft.
  const canResume = isDraftPreview
    ? existingSession && existingSession.testId === test.id
    : attemptResumed && existingSession && existingSession.testId === test.id;

  if (canResume) {
    hydrateFromSession(existingSession);
  } else {
    clearSession(); // discard any stale/unrelated local session — this is a fresh attempt, always start at question 1
    state.studentName = previewAsEmail || profile?.display_name || profile?.email || "Admin Preview";
    state.startedAt = Date.now();
    state.remainingSeconds = test.noTimeLimit ? Number.MAX_SAFE_INTEGER : test.durationMinutes * 60;
    state.currentPageIndex = sectionPageRange(0).first;
    persistSession();
  }

  els.examTestTitle.textContent = test.title;
  renderSectionProgress();
  renderPalette(els.paletteGrid, currentSectionQuestionIndex(), jumpToQuestionId);
  renderPage(state.currentPageIndex);
  refreshPaletteAndSummary();
  bindEvents();
  applyZoom();
  hidePageLoader();

  // A fresh start shows the security notice first — resuming (refresh,
  // reopening the tab) skips it, since the student already acknowledged
  // it once for this attempt and re-showing it mid-exam would just be
  // friction with no informational value. Fullscreen is requested from
  // inside a direct user-gesture click handler specifically because a
  // request made outside one is often silently denied by the browser —
  // see ensureFullscreenBeforeContinuing()/openFullscreenRequirement()
  // below for the actual gate, which also verifies the request really
  // succeeded rather than assuming it did.
  if (canResume) {
    startTimer();
    beginSecuredExam(false);
  } else {
    openExamStartNotice();
  }
}

/**
 * @param {boolean} isInitialStart - true only for the very first "Start
 * Exam" click (never for a resume). Passed through to
 * ensureFullscreenBeforeContinuing(), which is the only place that
 * decides whether/when startTimer() runs for that path — the resume
 * path above already started its own timer, unchanged, before this is
 * ever called, and this function must never start a second one.
 */
function beginSecuredExam(isInitialStart) {
  initSecurity();
  initBackButtonTrap();
  ensureFullscreenBeforeContinuing(isInitialStart);
}

/** True only when this test's admin-configured security settings actually require fullscreen AND the browser genuinely supports the Fullscreen API — a student on a browser/embedded webview without it is never permanently blocked by a requirement it has no way to satisfy. */
function fullscreenIsRequired() {
  return !!test.securitySettings?.requestFullscreen && document.fullscreenEnabled !== false && typeof document.documentElement.requestFullscreen === "function";
}

/** Runs once right after initSecurity() on both the initial start and every resume. If fullscreen isn't required (or the browser can't do it, or the student is already in it), nothing blocks — and for the initial-start path specifically, THIS is where the exam timer actually starts, so the exam genuinely "doesn't begin" until fullscreen is confirmed, without touching the timer's own pause/resume policy anywhere else. */
function ensureFullscreenBeforeContinuing(isInitialStart) {
  if (!fullscreenIsRequired() || document.fullscreenElement) {
    if (isInitialStart) startTimer();
    return;
  }
  openFullscreenRequirement(isInitialStart);
}

/** The ONE fullscreen-requirement dialog, reused for both the pre-exam gate and any mid-exam exit — text/button label set here depending on which moment this is; never mentions the underlying browser API or detection mechanism to the student. */
function openFullscreenRequirement(isInitialStart) {
  pendingFullscreenIsInitialStart = isInitialStart;
  els.examFullscreenText.textContent = isInitialStart
    ? "Fullscreen is required for this exam. Please enter fullscreen to begin your test."
    : "Fullscreen is required to continue your exam. Please return to fullscreen to continue.";
  els.examFullscreenBtn.textContent = isInitialStart ? "Enter Fullscreen" : "Return to Fullscreen";
  els.examFullscreenError.hidden = true;
  if (!els.examFullscreenModal.open) els.examFullscreenModal.showModal();
}

/** Never assumes requestFullscreen() succeeded just because it resolved — re-checks document.fullscreenElement afterward, which is the only reliable signal (rejection, silent no-op, and success all resolve the same promise shape). Only on a confirmed success does the modal close and (for the initial-start path only) the timer start. */
async function handleFullscreenRequirementClick() {
  els.examFullscreenError.hidden = true;
  if (fullscreenGuard) await fullscreenGuard.requestFullscreen();
  if (document.fullscreenElement) {
    els.examFullscreenModal.close();
    logSecurityEvent("fullscreen_entered");
    if (pendingFullscreenIsInitialStart) startTimer();
    pendingFullscreenIsInitialStart = false;
  } else {
    els.examFullscreenError.hidden = false;
  }
}

function openExamStartNotice() {
  const sec = test.securitySettings;
  els.examStartNoticeList.innerHTML = "";
  const lines = [];
  if (sec.disableCopy || sec.disableCut || sec.disablePaste) lines.push("Copying, cutting, and pasting are disabled.");
  if (sec.disableTextSelection) lines.push("Text selection is disabled.");
  if (sec.disableContextMenu) lines.push("Right-click is disabled.");
  if (sec.disablePrint) lines.push("Printing is disabled.");
  lines.push("Please remain on the exam screen.");
  if (sec.detectFullscreenExit) lines.push("Leaving fullscreen may trigger a warning.");
  lines.push("Previous sections cannot be reopened.");
  lines.forEach((line) => {
    const li = document.createElement("li");
    li.textContent = `• ${line}`;
    els.examStartNoticeList.appendChild(li);
  });
  els.examStartNoticeModal.showModal();
}

/** The first/last page index belonging to a given section — sections are always contiguous runs of pages, since a group belongs to exactly one section (see loader.js's normalizeGroup). */
function sectionPageRange(sectionIndex) {
  const indices = [];
  test.pages.forEach((p, i) => { if (p.sectionIndex === sectionIndex) indices.push(i); });
  return { first: indices[0], last: indices[indices.length - 1] };
}

/** Only the CURRENT section's questions — used for the palette (navigation must never reach into a locked or upcoming section) and section-scoped progress. */
function currentSectionQuestionIndex() {
  return test.questionIndex.filter((e) => e.sectionIndex === state.currentSectionIndex);
}

function hydrateFromSession(session) {
  state.studentName = session.studentName || "Student";
  state.currentSectionIndex = clampSectionIndex(session.currentSectionIndex || 0);
  state.completedSections = Array.isArray(session.completedSections) ? session.completedSections : [];
  state.securityEvents = Array.isArray(session.securityEvents) ? session.securityEvents : [];
  // Defensive floor: never restore into a page that belongs to an already-completed section, even if the raw stored pageIndex somehow predates it (e.g. session shape changed between visits).
  const { first, last } = sectionPageRange(state.currentSectionIndex);
  state.currentPageIndex = Math.min(Math.max(clampPageIndex(session.currentPageIndex || first), first), last);
  state.answers = session.answers || {};
  state.bookmarks = session.bookmarks || [];
  state.visited = session.visited || [];
  state.startedAt = session.startedAt || Date.now();
  state.remainingSeconds = test.noTimeLimit
    ? Number.MAX_SAFE_INTEGER
    : typeof session.remainingSeconds === "number"
    ? session.remainingSeconds
    : test.durationMinutes * 60;
}

function clampPageIndex(i) {
  return Math.min(Math.max(i, 0), test.pages.length - 1);
}

function clampSectionIndex(i) {
  return Math.min(Math.max(i, 0), test.sections.length - 1);
}

function persistSession() {
  if (!test) return;
  saveSession({
    testId: test.id,
    studentName: state.studentName,
    startedAt: state.startedAt,
    durationSeconds: test.durationMinutes * 60,
    remainingSeconds: state.remainingSeconds,
    currentPageIndex: state.currentPageIndex,
    currentSectionIndex: state.currentSectionIndex,
    completedSections: state.completedSections,
    securityEvents: state.securityEvents,
    answers: state.answers,
    bookmarks: state.bookmarks,
    visited: state.visited,
  });
}

/* =========================================================
   RENDERING — one GROUP (page) at a time
   ========================================================= */
function renderPage(pageIndex) {
  const group = test.pages[pageIndex];
  if (!group) return;

  group.questions.forEach((q) => markVisited(q.id));

  renderSectionBanner(group);
  renderGroupContent(group);
  renderProgress(group);

  const { first, last } = sectionPageRange(state.currentSectionIndex);
  els.prevBtn.disabled = pageIndex === first;
  const isLastPageOfSection = pageIndex === last;
  const isFinalSection = state.currentSectionIndex === test.sections.length - 1;
  els.nextBtnLabel.textContent = isLastPageOfSection ? (isFinalSection ? "Finish" : "Next Section") : "Next";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderSectionBanner(group) {
  if (group.sectionIndex === lastRenderedSectionIndex) {
    els.sectionBanner.hidden = true;
    return;
  }
  lastRenderedSectionIndex = group.sectionIndex;
  els.sectionBanner.hidden = false;
  els.sectionBannerIndex.textContent = `Section ${group.sectionIndex + 1} of ${test.sections.length}`;
  els.sectionBannerTitle.textContent = group.sectionTitle;
}

function renderProgress(group) {
  const sectionEntries = currentSectionQuestionIndex();
  const orders = group.questions.map((q) => sectionEntries.findIndex((e) => e.id === q.id) + 1);
  const total = sectionEntries.length;
  const label = orders.length > 1 ? `Question ${orders[0]}-${orders[orders.length - 1]} of ${total}` : `Question ${orders[0]} of ${total}`;
  els.examProgressText.textContent = label;
  els.progressBarFill.style.width = `${(orders[orders.length - 1] / total) * 100}%`;
}

/** The persistent, informational-only 4-section indicator — never clickable; completed sections read as locked/done, the current one is highlighted, upcoming ones are visibly inert. Re-rendered on init and every time a section actually advances. */
function renderSectionProgress() {
  els.examSectionProgress.innerHTML = "";
  let currentEl = null;
  test.sections.forEach((section, i) => {
    const isCompleted = i < state.currentSectionIndex;
    const isCurrent = i === state.currentSectionIndex;
    const item = document.createElement("div");
    item.className = "exam-section-progress-item" + (isCompleted ? " completed" : isCurrent ? " current" : " upcoming");
    if (isCurrent) {
      item.setAttribute("aria-current", "true");
      currentEl = item;
    }
    const glyph = isCompleted ? "✓" : isCurrent ? "●" : "○";
    item.innerHTML = `<span class="exam-section-progress-glyph">${glyph}</span><span class="exam-section-progress-title">${escapeHtmlLocal(section.title)}</span>`;
    els.examSectionProgress.appendChild(item);
  });
  // Keep the active section visible without requiring the student to
  // manually scroll the row — relevant once section count/name length
  // exceeds what fits in one screen width.
  currentEl?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
}

/** Tiny local escaper — this file has no existing HTML-escape import and section titles are trusted admin data anyway (never rendered via innerHTML elsewhere without going through groupRenderer's own escaping), but a section title is technically free text so this stays defensive rather than assuming it. */
function escapeHtmlLocal(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderGroupContent(group) {
  els.groupContent.innerHTML = "";

  const sharedBlock = buildSharedBlock(group);
  if (sharedBlock) els.groupContent.appendChild(sharedBlock);

  renderQuestionList(group);
}

/**
 * Rebuilds ONLY the question cards (radio selections, bookmarks) for
 * the current group — deliberately leaves the shared block (built by
 * buildSharedBlock: the group's audio/image/passage) completely alone.
 *
 * Selecting an answer used to call the FULL renderGroupContent(),
 * which does `els.groupContent.innerHTML = ""` and rebuilds
 * everything from scratch — including a brand-new <audio> element,
 * which necessarily reset/stopped any in-progress playback the instant
 * a student picked an answer. This is what actually fixes that: only
 * the part of the DOM that can genuinely change on a selection (which
 * option is marked selected, the listening "N/M answered" hint) gets
 * rebuilt; the audio/image node itself is never touched, so playback
 * continues uninterrupted.
 */
function renderQuestionList(group) {
  els.groupContent.querySelector(".group-completion-hint")?.remove();
  els.groupContent.querySelector(".question-block-list")?.remove();

  if (group.type === "listening_group") {
    const completion = computeGroupCompletion(group, state.answers);
    if (!completion.complete) {
      const hint = document.createElement("p");
      hint.className = "group-completion-hint";
      hint.textContent = `Answer all ${completion.total} questions in this section before continuing (${completion.answered}/${completion.total} answered).`;
      els.groupContent.appendChild(hint);
    }
  }

  const list = document.createElement("div");
  list.className = "question-block-list";
  group.questions.forEach((q) => {
    const entry = test.questionIndex.find((e) => e.id === q.id);
    list.appendChild(
      buildQuestionBlock(q, entry.order, group, {
        readOnly: false,
        selectedAnswer: state.answers[q.id] ?? null,
        onSelectOption: (option) => selectOption(q.id, option),
        bookmarked: state.bookmarks.includes(q.id),
        onToggleBookmark: (e) => toggleBookmark(q.id, e.currentTarget),
      })
    );
  });
  els.groupContent.appendChild(list);
}

/**
 * Purely updates which option is marked selected for ONE question,
 * directly on the already-rendered DOM — never removes or recreates
 * any card, which is exactly why this is safe to call on every answer
 * selection. renderQuestionList() above rebuilds every card from
 * scratch (needed for genuine navigation to a new group), but a
 * "single"-type question can have its OWN <audio> element rendered
 * inside its card by buildQuestionBlock() (see groupRenderer.js) — a
 * full rebuild on every selection was destroying and recreating that
 * audio every time, restarting playback, even though the earlier fix
 * for the SHARED group audio (buildSharedBlock, listening groups) was
 * already correct. This function is what closes that second, real gap:
 * it only ever toggles a class and a `checked` property on inputs that
 * already exist, so nothing inside the card — audio, image, or
 * otherwise — is ever destroyed by selecting an answer.
 */
function updateOptionSelectionInDOM(questionId, selectedOption) {
  const card = document.getElementById(`question-anchor-${questionId}`);
  if (!card) return;
  card.querySelectorAll(".option-item").forEach((item) => {
    const input = item.querySelector("input");
    const isSelected = input && input.value === selectedOption;
    item.classList.toggle("selected", isSelected);
    if (input) input.checked = isSelected;
  });
}

/** Same "never destroy an existing card" principle as above — only touches the one text hint (which contains no media), never the question cards or the shared block. */
function updateListeningHintInDOM(group) {
  if (group.type !== "listening_group") return;
  const completion = computeGroupCompletion(group, state.answers);
  const existingHint = els.groupContent.querySelector(".group-completion-hint");
  if (completion.complete) {
    existingHint?.remove();
    return;
  }
  const text = `Answer all ${completion.total} questions in this section before continuing (${completion.answered}/${completion.total} answered).`;
  if (existingHint) {
    existingHint.textContent = text;
  } else {
    const hint = document.createElement("p");
    hint.className = "group-completion-hint";
    hint.textContent = text;
    const list = els.groupContent.querySelector(".question-block-list");
    els.groupContent.insertBefore(hint, list);
  }
}

/* =========================================================
   STATE MUTATIONS
   ========================================================= */
function markVisited(questionId) {
  if (!state.visited.includes(questionId)) state.visited.push(questionId);
}

function selectOption(questionId, option) {
  state.answers[questionId] = option;
  updateOptionSelectionInDOM(questionId, option);
  updateListeningHintInDOM(test.pages[state.currentPageIndex]);
  refreshPaletteAndSummary();
  autoSaveScheduled();
}

function toggleBookmark(questionId, btnEl) {
  const idx = state.bookmarks.indexOf(questionId);
  if (idx === -1) state.bookmarks.push(questionId);
  else state.bookmarks.splice(idx, 1);
  btnEl.setAttribute("aria-pressed", String(idx === -1));
  refreshPaletteAndSummary();
  autoSaveScheduled();
}

function jumpToQuestionId(questionId) {
  const location = findQuestionLocation(test, questionId);
  if (!location) return;
  // Defensive backstop — the palette itself only ever renders the current section's questions (see currentSectionQuestionIndex), but this guards against jumping to a locked/upcoming section by any other path (e.g. a stale anchor).
  if (location.entry.sectionIndex !== state.currentSectionIndex) return;
  const targetPageIndex = location.entry.pageIndex;
  const samePage = targetPageIndex === state.currentPageIndex;
  state.currentPageIndex = targetPageIndex;
  renderPage(state.currentPageIndex);
  refreshPaletteAndSummary();
  persistSession();
  closePalette();

  requestAnimationFrame(() => {
    const anchor = document.getElementById(`question-anchor-${questionId}`);
    anchor?.scrollIntoView({ behavior: samePage ? "smooth" : "auto", block: "start" });
  });
}

function goPrev() {
  const { first } = sectionPageRange(state.currentSectionIndex);
  if (state.currentPageIndex > first) {
    state.currentPageIndex -= 1;
    renderPage(state.currentPageIndex);
    refreshPaletteAndSummary();
    persistSession();
  }
}

function goNext() {
  const currentGroup = test.pages[state.currentPageIndex];

  // Any required question on the page currently being LEFT blocks
  // advancing — but silently: no popup, no modal, no toast, no visual
  // feedback of any kind (per explicit owner request). The student just
  // stays on the current question, exactly as if Next did nothing,
  // until they answer it. This mirrors the listening-group completion
  // check right below, which already worked this way.
  const missingOnThisPage = findMissingRequiredQuestions(state.currentSectionIndex).filter(
    (entry) => entry.pageIndex === state.currentPageIndex
  );
  if (missingOnThisPage.length > 0) {
    return;
  }

  // Spec requirement: a listening group must be fully answered before advancing.
  if (currentGroup.type === "listening_group") {
    const completion = computeGroupCompletion(currentGroup, state.answers);
    if (!completion.complete) {
      updateListeningHintInDOM(currentGroup); // only the "N/M answered" hint text changes here — the question cards themselves haven't changed, so there's nothing to touch, and nothing to risk destroying
      return;
    }
  }

  const { last } = sectionPageRange(state.currentSectionIndex);
  if (state.currentPageIndex < last) {
    state.currentPageIndex += 1;
    renderPage(state.currentPageIndex);
    refreshPaletteAndSummary();
    persistSession();
    return;
  }

  // Previously, reaching the last page of a section re-checked the WHOLE
  // section and popped the same "Required Question" warning if an
  // earlier page's required question had been skipped (e.g. via a
  // palette jump straight to the last page). That popup is removed
  // per the owner's explicit request, and — unlike the per-page check
  // above — it is NOT replaced with a silent block: the student would
  // have no visible cause and no way to fix a page they've already left.
  // The real safety net for a truly-skipped required question still
  // exists, untouched, at actual final submission time: openSubmitConfirm()
  // below shows its own inline required-question list and disables the
  // Submit button — a genuinely different, already-existing mechanism,
  // not this popup.
  const isFinalSection = state.currentSectionIndex === test.sections.length - 1;
  if (isFinalSection) {
    openSubmitConfirm();
  } else {
    openSectionCompleteConfirm();
  }
}

/** Permanently advances past the current section — called only after the section-complete confirmation and the brief transition animation. This is the one place `currentSectionIndex`/`completedSections` ever move forward; nothing else in this file mutates them. */
function advanceToNextSection() {
  const finishedIndex = state.currentSectionIndex;
  if (!state.completedSections.includes(finishedIndex)) state.completedSections.push(finishedIndex);
  state.currentSectionIndex = clampSectionIndex(finishedIndex + 1);
  state.currentPageIndex = sectionPageRange(state.currentSectionIndex).first;
  lastRenderedSectionIndex = -1; // force the section banner to show again for the new section
  persistSession();
  renderSectionProgress();
  renderPalette(els.paletteGrid, currentSectionQuestionIndex(), jumpToQuestionId);
  renderPage(state.currentPageIndex);
  refreshPaletteAndSummary();
}

function openSectionCompleteConfirm() {
  els.sectionCompleteName.textContent = test.sections[state.currentSectionIndex].title;
  els.sectionCompleteModal.showModal();
}

/** Brief, non-interactive confirmation shown between "section locked" and the next section actually appearing — purely informational, per spec ~500-1200ms. */
function showSectionTransition(onDone) {
  const fromTitle = test.sections[state.currentSectionIndex].title;
  const isFinalSection = state.currentSectionIndex === test.sections.length - 1;
  const toTitle = isFinalSection ? null : test.sections[state.currentSectionIndex + 1].title;

  els.sectionTransitionLabel.textContent = "Section Complete";
  els.sectionTransitionFromName.textContent = fromTitle;
  els.sectionTransitionArrowRow.hidden = !toTitle;
  if (toTitle) els.sectionTransitionToName.textContent = toTitle;

  els.sectionTransitionOverlay.hidden = false;
  requestAnimationFrame(() => els.sectionTransitionOverlay.classList.add("visible"));
  setTimeout(() => {
    els.sectionTransitionOverlay.classList.remove("visible");
    setTimeout(() => {
      els.sectionTransitionOverlay.hidden = true;
      onDone();
    }, 200); // matches the CSS fade-out duration
  }, 900);
}

/**
 * Same overlay/animation as showSectionTransition() above — reused, not
 * duplicated — but for the moment the whole exam finishes, right before
 * leaving for the result page. Shows a short message (no
 * from/arrow-to-next-section row, since there's nothing "next" to name)
 * then calls onDone(), which callers use to actually navigate.
 */
function showFinishTransition(message, onDone) {
  els.sectionTransitionLabel.textContent = message;
  els.sectionTransitionFromName.textContent = "";
  els.sectionTransitionArrowRow.hidden = true;

  els.sectionTransitionOverlay.hidden = false;
  requestAnimationFrame(() => els.sectionTransitionOverlay.classList.add("visible"));
  setTimeout(() => {
    els.sectionTransitionOverlay.classList.remove("visible");
    setTimeout(() => {
      els.sectionTransitionOverlay.hidden = true;
      onDone();
    }, 200);
  }, 1100);
}

function refreshPaletteAndSummary() {
  updatePaletteState(els.paletteGrid, {
    questionIndex: test.questionIndex,
    answers: state.answers,
    visited: state.visited,
    bookmarks: state.bookmarks,
    currentPageIndex: state.currentPageIndex,
  });
  const summary = computeSummary(test.questionIndex, state.answers, state.bookmarks);
  els.summaryAnswered.textContent = String(summary.answered);
  els.summaryUnanswered.textContent = String(summary.unanswered);
  els.summaryBookmarked.textContent = String(summary.bookmarked);
}

/* =========================================================
   PALETTE BOTTOM SHEET
   ========================================================= */
function openPalette() {
  els.sheetBackdrop.hidden = false;
  els.paletteSheet.hidden = false;
  requestAnimationFrame(() => els.paletteSheet.classList.add("open"));
  els.paletteToggleBtn.setAttribute("aria-expanded", "true");
}
function closePalette() {
  els.paletteSheet.classList.remove("open");
  els.paletteToggleBtn.setAttribute("aria-expanded", "false");
  setTimeout(() => {
    els.sheetBackdrop.hidden = true;
    els.paletteSheet.hidden = true;
  }, 260);
}
function togglePalette() {
  if (els.paletteSheet.hidden) openPalette();
  else closePalette();
}

/* =========================================================
   TIMER
   ========================================================= */
function startTimer() {
  if (test.noTimeLimit) {
    els.timerText.textContent = "No limit";
    return;
  }
  timer = new ExamTimer(
    state.remainingSeconds,
    (remaining) => {
      state.remainingSeconds = remaining;
      els.timerText.textContent = formatTime(remaining);
      els.timerDisplay.classList.remove("timer-warning", "timer-danger");
      const cls = getTimerState(remaining);
      if (cls) els.timerDisplay.classList.add(cls);
      persistSession();
    },
    () => submitTest(true)
  );
  timer.start();
}

/* =========================================================
   SUBMIT FLOW — iterates every question across every section/group
   ========================================================= */
function openSubmitConfirm() {
  const summary = computeSummary(test.questionIndex, state.answers, state.bookmarks);
  els.confirmAnswered.textContent = String(summary.answered);
  els.confirmUnanswered.textContent = String(summary.unanswered);
  els.confirmBookmarked.textContent = String(summary.bookmarked);

  const missingRequired = findMissingRequiredQuestions();
  els.requiredWarning.hidden = missingRequired.length === 0;
  els.requiredWarningList.innerHTML = "";
  missingRequired.forEach((entry) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "required-warning-item";
    btn.textContent = `Q${entry.order}`;
    btn.addEventListener("click", () => { els.submitConfirmModal.close(); jumpToQuestionId(entry.id); });
    els.requiredWarningList.appendChild(btn);
  });
  els.confirmSubmitBtn.disabled = missingRequired.length > 0;

  els.submitConfirmModal.showModal();
}

/** Every required-but-unanswered question, in question order — used both to block submission (spec: "required questions must be answered before submitting") and to let the admin/student jump straight to each one from the confirmation dialog. */
/** With no argument, scans the WHOLE exam (used as a final belt-and-suspenders check right before submission, even though by then every prior section's gate has already passed). With a sectionIndex, scans only that section (used by goNext()'s per-section gate). */
function findMissingRequiredQuestions(sectionIndex = null) {
  return test.questionIndex
    .filter((entry) => sectionIndex === null || entry.sectionIndex === sectionIndex)
    .map((entry) => {
      const group = test.pages[entry.pageIndex];
      const q = group.questions.find((qq) => qq.id === entry.id);
      return { ...entry, required: q?.required };
    })
    .filter((entry) => entry.required && (state.answers[entry.id] === undefined || state.answers[entry.id] === null));
}

async function submitTest(isAutoSubmit = false) {
  if (timer) timer.stop();
  logSecurityEvent("exam_submitted");

  const params = new URLSearchParams(window.location.search);
  const isDraftPreview = params.get("adminPreview") === "1";

  // Draft preview (admin's own unsaved local draft, opened via "Test as
  // User" in the editor) never touches Supabase at all — there's no
  // attempt row, no server to ask, and the admin is allowed to see
  // correctOption in their own unpublished content anyway. This is the
  // ONE path that still computes a score locally in the browser — every
  // other path (real students, and admin "Preview as User" of a real
  // published test) is server-authoritative, below.
  if (isDraftPreview) {
    submitDraftPreviewLocally(isAutoSubmit);
    return;
  }

  // Everyone else: send raw answers only — never a score, never
  // correctOption, never isCorrect — and let the submit-attempt Edge
  // Function (which loads the REAL test content server-side, including
  // for admin live-preview) be the only source of truth. See
  // js/loader.js's get_exam_content() RPC call for the matching
  // server-side half of this: the content THIS page holds in memory
  // for an ordinary student never contained correctOption in the first
  // place, so there'd be nothing meaningful to score locally even if we
  // tried.
  if (!state.attemptId) {
    showSubmitFailedModal(isAutoSubmit, "No attempt was recorded for this exam session — please check your connection and try again.");
    return;
  }

  els.confirmSubmitBtn.disabled = true;
  els.confirmSubmitBtn.textContent = "Submitting…";

  const serverResult = await submitAttemptServerSide(state.attemptId, {
    answers: state.answers,
    securityEvents: state.securityEvents,
    autoSubmitted: isAutoSubmit,
    studentName: state.studentName,
  });

  els.confirmSubmitBtn.disabled = false;
  els.confirmSubmitBtn.textContent = "Submit Exam";

  if (!serverResult) {
    // Deliberately do NOT fall back to a locally-computed result here —
    // the client never had correctOption for a real student's session,
    // so there is nothing honest to show. Keep the session (answers are
    // NOT lost) and offer a retry instead.
    showSubmitFailedModal(isAutoSubmit);
    return;
  }

  clearSession();
  allowUnload = true;
  const resultParams = new URLSearchParams(window.location.search);
  resultParams.set("attemptId", state.attemptId);
  showFinishTransition("Exam Submitted", () => {
    window.location.href = `result.html?${resultParams.toString()}`;
  });
}

/** The one place client-side scoring still happens — admin's own unsaved local draft only (see submitTest()'s isDraftPreview branch above). Logic unchanged from before the correctOption security fix; this content never leaves the admin's own browser. */
function submitDraftPreviewLocally(isAutoSubmit) {
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  let marksScored = 0;

  const sectionAgg = new Map();

  const detailedAnswers = test.questionIndex.map((entry) => {
    const group = test.pages[entry.pageIndex];
    const q = group.questions.find((qq) => qq.id === entry.id);
    const given = state.answers[q.id];
    const isAnswered = given !== undefined && given !== null;
    const isCorrect = isAnswered && given === q.correctOption;

    if (!sectionAgg.has(entry.sectionTitle)) {
      sectionAgg.set(entry.sectionTitle, { sectionId: test.sections[entry.sectionIndex]?.id || entry.sectionTitle, totalQuestions: 0, correct: 0, wrong: 0, earnedPoints: 0, availablePoints: 0 });
    }
    const agg = sectionAgg.get(entry.sectionTitle);
    agg.totalQuestions += 1;
    agg.availablePoints += q.marks;

    if (!isAnswered) skipped += 1;
    else if (isCorrect) {
      correct += 1;
      marksScored += q.marks;
      agg.correct += 1;
      agg.earnedPoints += q.marks;
    } else {
      wrong += 1;
      agg.wrong += 1;
    }

    return {
      questionId: q.id,
      order: entry.order,
      question: q.text,
      passage: group.type === "passage_group" ? group.passageText : null,
      options: q.options,
      correctOption: q.correctOption,
      givenOption: given ?? null,
      isCorrect,
      explanation: q.explanation,
      marks: q.marks,
      imageUrl: group.imageUrl,
      audioUrl: group.audioUrl,
      bookmarked: state.bookmarks.includes(q.id),
      sectionTitle: entry.sectionTitle,
      groupType: group.type,
    };
  });

  const percentage = test.totalMarks > 0 ? Math.round((marksScored / test.totalMarks) * 1000) / 10 : 0;
  const rs = test.resultSettings;
  const finalScore = convertRawScore(marksScored, test.totalMarks, rs);
  const passed = finalScore >= rs.passingScore;
  const sections = [...sectionAgg.values()].map((s) => ({
    ...s,
    percentage: s.availablePoints > 0 ? Math.round((s.earnedPoints / s.availablePoints) * 100) : 0,
  }));

  const result = {
    testId: test.id,
    testTitle: test.title,
    category: test.category,
    studentName: state.studentName,
    submittedAt: new Date().toISOString(),
    autoSubmitted: isAutoSubmit,
    totalQuestions: test.totalQuestions,
    correct,
    wrong,
    skipped,
    marksScored,
    totalMarks: test.totalMarks,
    percentage,
    passMarks: test.passMarks,
    passed,
    answers: detailedAnswers,
    sections,
    finalScore,
    resultSettings: rs,
    securityEvents: state.securityEvents,
  };

  saveResult(result);
  clearSession();
  allowUnload = true;
  showFinishTransition("Exam Submitted", () => {
    window.location.href = "result.html?adminPreview=1";
  });
}

/** Shown when submitAttemptServerSide() fails for a real (non-draft-preview) submission — offline, the Edge Function not deployed, etc. Deliberately blocking and retry-only, never a silent fallback to a fabricated score. The session is NOT cleared, so Retry re-sends the exact same answers. */
function showSubmitFailedModal(isAutoSubmit, message) {
  els.submitFailedMessage.textContent =
    message || "Your exam couldn't be submitted — please check your internet connection. Your answers are saved; do not close this tab.";
  pendingRetryIsAutoSubmit = isAutoSubmit;
  if (!els.submitFailedModal.open) els.submitFailedModal.showModal();
}

/** Converts a raw marks-scored value into the score shown on the JFT-style result panel, per the test's configured mode (raw/percentage/scaled) — see loader.js's DEFAULT_RESULT_SETTINGS for the field shapes. Always clamped to [minScore, maxScore] for a defensible bar-marker position even with unusual settings. Exported (not just used internally) so this is the one place the logic lives and can be tested directly, per "do not duplicate score-calculation logic in multiple places". */
export function convertRawScore(raw, totalMarks, rs) {
  let value;
  if (rs.scoreMode === "percentage") {
    const pct = totalMarks > 0 ? raw / totalMarks : 0;
    value = rs.minScore + pct * (rs.maxScore - rs.minScore);
  } else if (rs.scoreMode === "scaled") {
    const rawMin = typeof rs.rawMin === "number" ? rs.rawMin : 0;
    const rawMax = typeof rs.rawMax === "number" && rs.rawMax !== null ? rs.rawMax : totalMarks;
    const span = rawMax - rawMin;
    const t = span > 0 ? Math.min(1, Math.max(0, (raw - rawMin) / span)) : 0;
    value = rs.finalMin + t * (rs.finalMax - rs.finalMin);
  } else {
    value = raw; // "raw" mode — the displayed score IS the marks scored
  }
  return Math.round(Math.min(rs.maxScore, Math.max(rs.minScore, value)));
}

/* =========================================================
   FULLSCREEN
   ========================================================= */
function toggleFullscreen() {
  if (!document.fullscreenElement) fullscreenGuard?.requestFullscreen();
  else document.exitFullscreen?.().catch(() => {});
}

/* =========================================================
   ZOOM — application-level, independent of browser/native zoom
   (which behaves inconsistently once fullscreen is active). A
   simple in-memory value for the current exam session only, per
   spec preference — resets to 100% on a fresh page load/session,
   same as the rest of this app's non-persisted UI state.
   ========================================================= */
const ZOOM_LEVELS = [80, 90, 100, 110, 120, 130, 140, 150];
let zoomLevel = 100;

function applyZoom() {
  document.documentElement.style.setProperty("--exam-zoom", String(zoomLevel / 100));
  els.zoomLevelText.textContent = `${zoomLevel}%`;
  els.zoomOutBtn.disabled = zoomLevel <= ZOOM_LEVELS[0];
  els.zoomInBtn.disabled = zoomLevel >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
}
function zoomOut() {
  const idx = ZOOM_LEVELS.indexOf(zoomLevel);
  if (idx > 0) {
    zoomLevel = ZOOM_LEVELS[idx - 1];
    applyZoom();
  }
}
function zoomIn() {
  const idx = ZOOM_LEVELS.indexOf(zoomLevel);
  if (idx < ZOOM_LEVELS.length - 1) {
    zoomLevel = ZOOM_LEVELS[idx + 1];
    applyZoom();
  }
}

// Two-finger pinch drives the exact same zoomLevel/applyZoom() the
// +/- buttons use — see utils.js's initPinchZoom for why this exists
// as a separate gesture implementation rather than relying on the
// browser's own native pinch-zoom.
initPinchZoom({
  getLevel: () => zoomLevel,
  setLevel: (n) => { zoomLevel = n; applyZoom(); },
  levels: ZOOM_LEVELS,
});

/* =========================================================
   SECURITY WIRING (see security.js for what is/isn't enforceable)
   ========================================================= */
function applyIntegrityThresholdAction() {
  switch (test.securitySettings.thresholdAction) {
    case "auto_submit":
      els.visibilityWarningText.innerHTML = "Maximum allowed violations reached.<br />Your exam is being submitted automatically.";
      if (!els.visibilityWarningModal.open) els.visibilityWarningModal.showModal();
      setTimeout(() => submitTest(true), 1500);
      break;
    case "warn":
      els.visibilityWarningText.innerHTML = "Maximum allowed violations reached.<br />Any further violation may end your exam.";
      if (!els.visibilityWarningModal.open) els.visibilityWarningModal.showModal();
      break;
    case "continue":
    default:
      break;
  }
}

/** Traps the browser Back button while an exam session is active — every Back press just re-pushes the current URL, so there's never anywhere "back" to actually go to (no route to a previous, now-locked section exists in this single-page design, but this also blocks the trivial case of the browser history containing e.g. the index.html "enter your name" page from before the exam started). Only installed once, in init(). */
function initBackButtonTrap() {
  if (backButtonTrapActive) return;
  backButtonTrapActive = true;
  history.pushState(null, "", location.href);
  window.addEventListener("popstate", () => {
    history.pushState(null, "", location.href);
  });
}

const SECURITY_TOAST_MESSAGES = {
  copy_attempt: "🔒 Copying is disabled during the exam.",
  cut_attempt: "🔒 Cutting is disabled during the exam.",
  paste_attempt: "🔒 Pasting is disabled during the exam.",
  context_menu_attempt: "🔒 Context menu is disabled during the exam.",
  select_attempt: null, // silent — selection blocks constantly during normal reading/scrolling, a toast per attempt would be spammy
  drag_attempt: null,
  print_attempt: "🔒 Printing is disabled during the exam.",
};

/** Structured, timestamped security event log — kept on the result the student submits (see submitTest) since this is a static, serverless site with no backend to report to live; see the DATA SAFETY note in the FINAL GOAL section of this feature's own spec for why this can only ever be a local record of the student's own attempt, not a real-time admin-facing feed. */
function logSecurityEvent(type) {
  if (test && test.securitySettings && test.securitySettings.trackSecurityEvents === false) return;
  state.securityEvents.push({ type, timestamp: Date.now() });
  autoSaveScheduled();
}

let toastHideTimeoutId = null;
function showSecurityToast(message) {
  if (!message) return; // some attempt kinds are intentionally silent, see SECURITY_TOAST_MESSAGES
  els.securityToastContainer.innerHTML = "";
  const toast = document.createElement("div");
  toast.className = "security-toast";
  toast.textContent = message;
  els.securityToastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  if (toastHideTimeoutId) clearTimeout(toastHideTimeoutId);
  toastHideTimeoutId = setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 250);
  }, 1800);
}

function initSecurity() {
  const sec = test.securitySettings;
  logSecurityEvent("exam_started");
  els.examModeIndicator.hidden = false;

  if (sec.disableTextSelection || sec.disableCopy || sec.disableCut || sec.disablePaste || sec.disableContextMenu) {
    lockdownInputSurface(
      document.body,
      {
        copy_attempt: sec.disableCopy,
        cut_attempt: sec.disableCut,
        paste_attempt: sec.disablePaste,
        context_menu_attempt: sec.disableContextMenu,
        select_attempt: sec.disableTextSelection,
        // Dragging content out isn't its own admin toggle in the spec's settings list — tie it to whichever "don't let them extract content" flags are on.
        drag_attempt: sec.disableTextSelection || sec.disableCopy,
      },
      (kind) => {
        logSecurityEvent(kind);
        showSecurityToast(SECURITY_TOAST_MESSAGES[kind]);
      }
    );
  }

  if (sec.blockShortcuts) blockKeyboardShortcuts();

  if (sec.disablePrint) {
    window.addEventListener("beforeprint", () => {
      logSecurityEvent("print_attempt");
      showSecurityToast(SECURITY_TOAST_MESSAGES.print_attempt);
    });
  }

  if (sec.requestFullscreen) {
    fullscreenGuard = initFullscreenGuard(() => {
      if (sec.detectFullscreenExit) {
        logSecurityEvent("fullscreen_exited");
        openFullscreenRequirement(false);
      }
    });
  }

  if (sec.blockShortcuts) {
    startDevToolsHeuristic(
      () => {
        logSecurityEvent("devtools_shortcut_attempt");
        els.devtoolsWarningText.textContent =
          "Your exam session is currently paused because the exam security requirements were interrupted.";
        if (!els.devtoolsWarningModal.open) els.devtoolsWarningModal.showModal();
      },
      () => {
        logSecurityEvent("devtools_shortcut_attempt");
        els.devtoolsWarningText.textContent =
          "Your exam is being submitted automatically because the exam security requirements were interrupted again.";
        if (!els.devtoolsWarningModal.open) els.devtoolsWarningModal.showModal();
        setTimeout(() => submitTest(true), 1500);
      }
    );
  }

  if (sec.detectTabSwitch) {
    initVisibilityGuard({
      maxViolations: sec.maxViolations,
      onHidden: () => {
        logSecurityEvent("tab_hidden");
        if (timer) timer.stop();
      },
      onResumeAfterPauseCap: () => {
        if (timer && !test.noTimeLimit) timer.start();
      },
      onRestored: ({ count, maxViolations }) => {
        logSecurityEvent("tab_returned");
        if (timer && !test.noTimeLimit) timer.start();
        els.visibilityWarningText.innerHTML = `Leaving the exam window is discouraged.<br />Violation: ${count} of ${maxViolations}.`;
        if (!els.visibilityWarningModal.open) els.visibilityWarningModal.showModal();
      },
      onThresholdReached: () => applyIntegrityThresholdAction(),
    });
  }
}

/* =========================================================
   EVENT BINDING
   ========================================================= */
function bindEvents() {
  els.prevBtn.addEventListener("click", goPrev);
  els.nextBtn.addEventListener("click", goNext);
  els.fullscreenBtn.addEventListener("click", toggleFullscreen);

  els.paletteToggleBtn.addEventListener("click", togglePalette);
  els.sheetBackdrop.addEventListener("click", closePalette);
  bindSwipeToClose(els.sheetDragHandle, els.paletteSheet, closePalette);

  els.cancelSubmitBtn.addEventListener("click", () => els.submitConfirmModal.close());
  els.confirmSubmitBtn.addEventListener("click", () => {
    els.submitConfirmModal.close();
    submitTest(false);
  });
  els.retrySubmitBtn.addEventListener("click", () => {
    els.submitFailedModal.close();
    submitTest(pendingRetryIsAutoSubmit);
  });

  els.startExamBtn.addEventListener("click", () => {
    els.examStartNoticeModal.close();
    beginSecuredExam(true);
  });
  els.examFullscreenBtn.addEventListener("click", handleFullscreenRequirementClick);
  els.zoomOutBtn.addEventListener("click", zoomOut);
  els.zoomInBtn.addEventListener("click", zoomIn);

  els.stayInSectionBtn.addEventListener("click", () => els.sectionCompleteModal.close());
  els.continueToNextSectionBtn.addEventListener("click", () => {
    els.sectionCompleteModal.close();
    showSectionTransition(() => advanceToNextSection());
  });

  els.devtoolsWarningDismissBtn.addEventListener("click", () => els.devtoolsWarningModal.close());
  els.visibilityWarningDismissBtn.addEventListener("click", () => els.visibilityWarningModal.close());

  els.questionSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const id = resolveJumpQuestionId(els.questionSearchInput.value, test.questionIndex);
      if (id) jumpToQuestionId(id);
      els.questionSearchInput.value = "";
    }
  });

  bindArrowKeyNavigation(goPrev, goNext);

  window.addEventListener("beforeunload", (e) => {
    // Skipped once the exam has genuinely finished (allowUnload is only
    // ever set true right before the post-submit redirect to
    // result.html) — without this, the browser's native "leave site?"
    // popup fired even on a completely successful, expected finish,
    // which is confusing rather than protective. It still fires
    // correctly for every OTHER way of leaving mid-exam (closing the
    // tab, navigating away, refreshing) since allowUnload stays false
    // the entire rest of the time.
    if (allowUnload) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

init();
