/**
 * review.js
 * Controller for review.html — displays every question with the student's
 * answer, correct answer, explanation, and supports filter + search.
 */
import { loadResult } from "./storage.js?v=7";
import { supabase } from "./supabaseClient.js?v=1";
import { requireAuth } from "./auth.js?v=4";
import { hidePageLoader, initThemeToggle, renderRichText, escapeHtml, getQueryParam, initPinchZoom } from "./utils.js?v=6";
import { initContentProtection, initFullscreenGuard } from "./security.js?v=5";

const els = {
  darkModeToggle: document.getElementById("darkModeToggle"),
  backToResultBtn: document.getElementById("backToResultBtn"),
  reviewList: document.getElementById("reviewList"),
  reviewMain: document.querySelector(".review-main"),
  reviewFullscreenModal: document.getElementById("reviewFullscreenModal"),
  reviewFullscreenText: document.getElementById("reviewFullscreenText"),
  reviewFullscreenError: document.getElementById("reviewFullscreenError"),
  reviewFullscreenBtn: document.getElementById("reviewFullscreenBtn"),
  reviewZoomOutBtn: document.getElementById("reviewZoomOutBtn"),
  reviewZoomInBtn: document.getElementById("reviewZoomInBtn"),
  reviewZoomLevelText: document.getElementById("reviewZoomLevelText"),
};

let result = null;
let reviewFullscreenGuard = null;

async function init() {
  initThemeToggle(els.darkModeToggle);

  const isAdminPreview = getQueryParam("adminPreview") === "1" || getQueryParam("preview") === "1";
  if (!isAdminPreview) {
    const profile = await requireAuth();
    if (!profile) return; // requireAuth() already redirected
  }

  const attemptId = getQueryParam("attemptId");
  result = attemptId ? await loadResultFromAttempt(attemptId) : loadResult();
  if (!result) {
    els.reviewList.innerHTML = `<div class="review-empty">No completed attempt found. Take a test first.</div>`;
    hidePageLoader();
    return;
  }

  bindEvents();
  renderList();
  if (els.reviewMain) initContentProtection(els.reviewMain);
  applyReviewZoom();
  ensureReviewFullscreen();
  hidePageLoader();
}

async function loadResultFromAttempt(attemptId) {
  const { data, error } = await supabase.from("test_attempts").select("result").eq("id", attemptId).single();
  if (error || !data?.result) {
    console.error("review.loadResultFromAttempt failed", error);
    return null;
  }
  return data.result;
}

function bindEvents() {
  els.backToResultBtn.addEventListener("click", () => {
    window.location.href = "result.html";
  });
  els.reviewFullscreenBtn.addEventListener("click", handleReviewFullscreenClick);
  els.reviewZoomOutBtn.addEventListener("click", zoomOutReview);
  els.reviewZoomInBtn.addEventListener("click", zoomInReview);
}

/* =========================================================
   FULLSCREEN REQUIREMENT — same reused UI pattern as exam.js's
   examFullscreenModal (own dialog/ids, "Review Mode" copy), built
   on the same shared initFullscreenGuard(). Applied unconditionally
   to every review view (including admin preview) rather than tied
   to the original test's per-test securitySettings, since the
   stored `result` object carries no such setting and this is a
   property of the REVIEW page itself, not the exam it came from.

   Unlike the exam page, review has no live security-event log to
   write to — the attempt is already submitted and immutable by the
   time a student is reviewing it, and there is no existing storage
   mechanism for a new "review fullscreen exited" event. Nothing is
   logged here; only the exam page's existing logging is preserved.
   ========================================================= */
function reviewFullscreenIsAvailable() {
  return document.fullscreenEnabled !== false && typeof document.documentElement.requestFullscreen === "function";
}

function openReviewFullscreenRequirement(isInitial) {
  els.reviewFullscreenText.textContent = isInitial
    ? "Fullscreen is required to view your answer review."
    : "Fullscreen is required to continue viewing your answer review.";
  els.reviewFullscreenBtn.textContent = isInitial ? "Enter Fullscreen" : "Return to Fullscreen";
  els.reviewFullscreenError.hidden = true;
  if (!els.reviewFullscreenModal.open) els.reviewFullscreenModal.showModal();
}

async function handleReviewFullscreenClick() {
  els.reviewFullscreenError.hidden = true;
  if (reviewFullscreenGuard) await reviewFullscreenGuard.requestFullscreen();
  if (document.fullscreenElement) {
    els.reviewFullscreenModal.close();
  } else {
    els.reviewFullscreenError.hidden = false;
  }
}

/** Called once the review content has been rendered — a browser/webview
 * without Fullscreen API support is never permanently blocked from a
 * requirement it has no way to satisfy. */
function ensureReviewFullscreen() {
  if (!reviewFullscreenIsAvailable()) return;
  reviewFullscreenGuard = initFullscreenGuard(() => openReviewFullscreenRequirement(false));
  if (!document.fullscreenElement) openReviewFullscreenRequirement(true);
}

/* =========================================================
   ZOOM — same application-level system as exam.js, scoped to
   .review-list only (css/review.css) via the shared --exam-zoom
   custom property (css/exam.css, now loaded on this page too).
   ========================================================= */
const REVIEW_ZOOM_LEVELS = [80, 90, 100, 110, 120, 130, 140, 150];
let reviewZoomLevel = 100;

function applyReviewZoom() {
  document.documentElement.style.setProperty("--exam-zoom", String(reviewZoomLevel / 100));
  els.reviewZoomLevelText.textContent = `${reviewZoomLevel}%`;
  els.reviewZoomOutBtn.disabled = reviewZoomLevel <= REVIEW_ZOOM_LEVELS[0];
  els.reviewZoomInBtn.disabled = reviewZoomLevel >= REVIEW_ZOOM_LEVELS[REVIEW_ZOOM_LEVELS.length - 1];
}
function zoomOutReview() {
  const idx = REVIEW_ZOOM_LEVELS.indexOf(reviewZoomLevel);
  if (idx > 0) {
    reviewZoomLevel = REVIEW_ZOOM_LEVELS[idx - 1];
    applyReviewZoom();
  }
}
function zoomInReview() {
  const idx = REVIEW_ZOOM_LEVELS.indexOf(reviewZoomLevel);
  if (idx < REVIEW_ZOOM_LEVELS.length - 1) {
    reviewZoomLevel = REVIEW_ZOOM_LEVELS[idx + 1];
    applyReviewZoom();
  }
}

// Two-finger pinch drives the exact same reviewZoomLevel/
// applyReviewZoom() the +/- buttons use — see utils.js's
// initPinchZoom and exam.js's matching wiring for why this exists.
initPinchZoom({
  getLevel: () => reviewZoomLevel,
  setLevel: (n) => { reviewZoomLevel = n; applyReviewZoom(); },
  levels: REVIEW_ZOOM_LEVELS,
});

function renderList() {
  if (!result.answers || result.answers.length === 0) {
    els.reviewList.innerHTML = `<div class="review-empty">No questions found for this attempt.</div>`;
    return;
  }

  els.reviewList.innerHTML = result.answers.map((answer, index) => renderReviewItem(answer, index)).join("");
}

function renderReviewItem(answer, index) {
  // answer.order is not currently present on stored results (the
  // submit-attempt Edge Function's detailedAnswers never set it) — this
  // was the cause of "Qundefined". Falling back to the item's own
  // position (index+1) is safe: detailedAnswers is always built by
  // iterating sections→groups→questions in the test's fixed array
  // order, the exact same traversal loader.js uses for its own
  // order:globalIndex+1 numbering during the exam — so index+1 here
  // matches the question number the student actually saw.
  const questionNumber = answer.order ?? index + 1;
  const statusClass = answer.givenOption === null ? "skipped" : answer.isCorrect ? "correct" : "wrong";
  const statusLabel = answer.givenOption === null ? "Skipped" : answer.isCorrect ? "Correct" : "Wrong";

  const passageHtml = answer.passage
    ? `<div class="review-passage">${renderRichText(answer.passage)}</div>`
    : "";

  const imageHtml = answer.imageUrl
    ? `<div class="review-image"><img src="${escapeHtml(answer.imageUrl)}" alt="Question illustration" loading="lazy" /></div>`
    : "";

  const audioHtml = answer.audioUrl
    ? `<audio class="review-audio" controls controlslist="nodownload" disableremoteplayback preload="none" src="${escapeHtml(answer.audioUrl)}"></audio>`
    : "";

  const optionsHtml = answer.options
    .filter((option) => (option || "").trim() !== "")
    .map((option) => {
      const isCorrectOption = option === answer.correctOption;
      const isGivenOption = option === answer.givenOption;
      let cls = "review-option";
      let tag = "";
      if (isCorrectOption) {
        cls += " is-correct";
        tag = "Correct Answer";
      } else if (isGivenOption && !isCorrectOption) {
        cls += " is-wrong";
        tag = "Your Answer";
      }
      return `<div class="${cls}"><span>${escapeHtml(option)}</span>${tag ? `<span class="review-option-tag">${tag}</span>` : ""}</div>`;
    })
    .join("");

  const explanationHtml = answer.explanation
    ? `<div class="review-explanation"><strong>Explanation:</strong> ${renderRichText(answer.explanation)}</div>`
    : "";

  const bookmarkTag = answer.bookmarked ? `<span class="review-item-tag">Bookmarked</span>` : "";
  // sectionTitle is already on every stored answer (submit-attempt's
  // computeResult() sets it per-question) — just wasn't rendered here before.
  const sectionHtml = answer.sectionTitle
    ? `<span class="review-item-section">${escapeHtml(answer.sectionTitle)}</span>`
    : "";

  return `
    <article class="card review-item">
      <div class="review-item-header">
        <div class="review-item-header-left">
          <span class="review-item-badge ${statusClass}">Q${questionNumber} · ${statusLabel}</span>
          ${sectionHtml}
        </div>
        <div class="review-item-tags">${bookmarkTag}</div>
      </div>
      ${passageHtml}
      <div class="review-question-text">${renderRichText(answer.question)}</div>
      ${imageHtml}
      ${audioHtml}
      <div class="review-options">${optionsHtml}</div>
      ${explanationHtml}
    </article>
  `;
}

init();
