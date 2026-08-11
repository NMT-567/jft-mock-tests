/**
 * result.js
 * Controller for result.html — renders the JFT-style score report from the
 * last completed attempt stored by exam.js via storage.js. All numbers
 * (final score, section percentages, pass/fail) were already computed by
 * exam.js at submission time and saved verbatim on the `result` object —
 * this file only renders them, it never recalculates scoring itself, so
 * there's exactly one place the scoring logic lives.
 */
import { loadResult } from "./storage.js?v=8";
import { supabase } from "./supabaseClient.js?v=1";
import { requireAuth } from "./auth.js?v=5";
import { hidePageLoader, initThemeToggle, stampYear, getQueryParam, initPinchZoom } from "./utils.js?v=6";
import { initContentProtection, initFullscreenGuard } from "./security.js?v=5";

const els = {
  resultMain: document.querySelector(".result-main"),
  darkModeToggle: document.getElementById("darkModeToggle"),
  resultTitleJa: document.getElementById("resultTitleJa"),
  resultTitleEn: document.getElementById("resultTitleEn"),
  resultTestMeta: document.getElementById("resultTestMeta"),
  scoreRangeValue: document.getElementById("scoreRangeValue"),
  jftScoreBig: document.getElementById("jftScoreBig"),
  scoreFailZone: document.getElementById("scoreFailZone"),
  scorePassZone: document.getElementById("scorePassZone"),
  scorePassingMarker: document.getElementById("scorePassingMarker"),
  scoreStudentMarker: document.getElementById("scoreStudentMarker"),
  scoreStudentMarkerValue: document.getElementById("scoreStudentMarkerValue"),
  scoreRangeMinLabel: document.getElementById("scoreRangeMinLabel"),
  scoreRangeMaxLabel: document.getElementById("scoreRangeMaxLabel"),
  scorePassingLabel: document.getElementById("scorePassingLabel"),
  jftPassFailBadge: document.getElementById("jftPassFailBadge"),
  resultMessageJa: document.getElementById("resultMessageJa"),
  resultMessageEn: document.getElementById("resultMessageEn"),
  sectionResultsList: document.getElementById("sectionResultsList"),
  reviewAnswersBtn: document.getElementById("reviewAnswersBtn"),
  resultFullscreenModal: document.getElementById("resultFullscreenModal"),
  resultFullscreenText: document.getElementById("resultFullscreenText"),
  resultFullscreenError: document.getElementById("resultFullscreenError"),
  resultFullscreenBtn: document.getElementById("resultFullscreenBtn"),
  resultZoomOutBtn: document.getElementById("resultZoomOutBtn"),
  resultZoomInBtn: document.getElementById("resultZoomInBtn"),
  resultZoomLevelText: document.getElementById("resultZoomLevelText"),
  resultZoomControls: document.getElementById("resultZoomControls"),
  resultBackBtn: document.getElementById("resultBackBtn"),
  resultHeaderTitle: document.getElementById("resultHeaderTitle"),
  resultHeaderMeta: document.getElementById("resultHeaderMeta"),
  resultMotivationCard: document.getElementById("resultMotivationCard"),
  resultMotivationTitle: document.getElementById("resultMotivationTitle"),
  resultMotivationBody: document.getElementById("resultMotivationBody"),
  resultTestTitleSubtle: document.getElementById("resultTestTitleSubtle"),
  resultExtraInfo: document.getElementById("resultExtraInfo"),
  resultExtraInfoList: document.getElementById("resultExtraInfoList"),
};

let resultFullscreenGuard = null;

// Matches loader.js's DEFAULT_RESULT_SETTINGS — used only as a fallback for
// attempts saved before this feature existed (no resultSettings on the
// stored result at all), so old completed attempts still render sensibly
// instead of throwing on missing fields.
const FALLBACK_RESULT_SETTINGS = {
  titleJa: "試験の結果をお知らせします。",
  titleEn: "Your test results are as follows.",
  minScore: 0,
  maxScore: 100,
  passingScore: 60,
  passedJa: "あなたは日本語能力水準に達しました。",
  passedEn: "You were assessed to have reached the required Japanese language proficiency level.",
  failedJa: "あなたは日本語能力水準には達していないと判定されました。",
  failedEn: "You were assessed to have not reached the required Japanese language proficiency level.",
  sectionLabels: {},
};

async function init() {
  stampYear();
  initThemeToggle(els.darkModeToggle);

  const isAdminPreview = getQueryParam("adminPreview") === "1" || getQueryParam("preview") === "1";
  if (!isAdminPreview) {
    const profile = await requireAuth();
    if (!profile) return; // requireAuth() already redirected
  }

  // Viewing a past attempt from the dashboard's "My Results"/"View Last
  // Result" links (result.html?attemptId=...) reads that specific attempt
  // from Supabase — RLS only returns it if it's the caller's own row (or
  // the caller is an admin). Otherwise, this is the page a student lands
  // on right after submitting, which still reads the local just-saved
  // copy — no network round-trip needed for the common case.
  const attemptId = getQueryParam("attemptId");
  const result = attemptId ? await loadResultFromAttempt(attemptId) : loadResult();
  if (!result) {
    els.resultTestMeta.textContent = "No completed attempt found.";
    els.resultHeaderTitle.textContent = "Result";
    els.resultHeaderMeta.textContent = "No completed attempt found.";
    els.reviewAnswersBtn.disabled = true;
    hidePageLoader();
    return;
  }

  await render(result);
  bindEvents();
  if (els.resultMain) initContentProtection(els.resultMain);
  applyZoom();
  ensureResultFullscreen();
  hidePageLoader();
}

async function loadResultFromAttempt(attemptId) {
  const { data, error } = await supabase.from("test_attempts").select("result").eq("id", attemptId).single();
  if (error || !data?.result) {
    console.error("result.loadResultFromAttempt failed", error);
    return null;
  }
  return data.result;
}

async function render(result) {
  // Older attempts saved before this feature shipped won't have
  // finalScore/sections/resultSettings — fall back to the raw fields that
  // have always existed so a pre-existing completed attempt still renders
  // something correct rather than crashing.
  const rs = result.resultSettings || FALLBACK_RESULT_SETTINGS;
  const finalScore = typeof result.finalScore === "number" ? result.finalScore : result.marksScored;
  const sections = Array.isArray(result.sections) ? result.sections : [];

  els.resultTitleJa.textContent = rs.titleJa || FALLBACK_RESULT_SETTINGS.titleJa;
  els.resultTitleEn.textContent = rs.titleEn || FALLBACK_RESULT_SETTINGS.titleEn;
  els.resultTestMeta.textContent = `${result.studentName} · ${result.testTitle}`;

  await renderHeader(result);
  renderMotivation(result, rs, finalScore);
  renderScorePanel(result, rs, finalScore);
  renderSectionResults(sections, rs);
  renderExtraInfo(result);
}

/** Header title/meta line: "[Test] Result" + "Mock Test Completed · [date] · Attempt [N]".
 * Attempt number is a REAL count from test_attempts (RLS already lets a
 * user read their own rows), never fabricated — if it can't be
 * determined (admin preview, no testId, or the query fails) it's
 * simply omitted from the line rather than guessed. */
async function renderHeader(result) {
  els.resultHeaderTitle.textContent = result.testTitle ? `${result.testTitle} Result` : "Result";
  els.resultTestTitleSubtle.textContent = result.testTitle || "";

  const parts = ["Mock Test Completed"];
  const dateStr = formatResultDate(result.submittedAt);
  if (dateStr) parts.push(dateStr);

  const attemptNumber = await computeAttemptNumber(result);
  if (attemptNumber) parts.push(`Attempt ${attemptNumber}`);

  els.resultHeaderMeta.textContent = parts.join(" · ");
}

function formatResultDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (isToday) return `Today, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** Real count of this student's submitted attempts on this test, up to
 * and including this one — not fabricated, and gracefully omitted
 * (returns null) rather than guessed if it can't be determined. */
async function computeAttemptNumber(result) {
  if (!result?.testId || !result?.submittedAt) return null;
  try {
    const { count, error } = await supabase
      .from("test_attempts")
      .select("id", { count: "exact", head: true })
      .eq("test_id", result.testId)
      .eq("status", "submitted")
      .lte("submitted_at", result.submittedAt);
    if (error || count == null) return null;
    return count;
  } catch {
    return null;
  }
}

/** Dynamic tier message — percentage-based, never affects scoring (this
 * only reads result.percentage, computed elsewhere; it's never written
 * back to). Falls back to computing a percentage from finalScore/min/max
 * if result.percentage itself is missing (older attempts). */
function renderMotivation(result, rs, finalScore) {
  let pct = typeof result.percentage === "number" && Number.isFinite(result.percentage) ? result.percentage : null;
  if (pct === null) {
    const min = typeof rs.minScore === "number" ? rs.minScore : FALLBACK_RESULT_SETTINGS.minScore;
    const max = typeof rs.maxScore === "number" ? rs.maxScore : FALLBACK_RESULT_SETTINGS.maxScore;
    pct = max > min && Number.isFinite(finalScore) ? ((finalScore - min) / (max - min)) * 100 : 0;
  }

  let tier, title, body;
  if (pct >= 70) {
    tier = "tier-high";
    title = "Excellent Work!";
    body = "Great job! Keep building your Japanese skills.";
  } else if (pct >= 40) {
    tier = "tier-mid";
    title = "Good Effort!";
    body = "Keep practicing and you'll get even stronger.";
  } else {
    tier = "tier-low";
    title = "Don't Give Up!";
    body = "Every practice makes you stronger. Practice again.";
  }

  els.resultMotivationCard.classList.remove("tier-high", "tier-mid", "tier-low");
  els.resultMotivationCard.classList.add(tier);
  els.resultMotivationTitle.textContent = title;
  els.resultMotivationBody.textContent = body;
}

/** Additional Result Information — only ever reads fields already on the
 * real result object; any genuinely-missing field is simply left out of
 * the list rather than shown as 0/NaN/undefined. */
function renderExtraInfo(result) {
  const rows = [
    ["Correct", result.correct],
    ["Wrong", result.wrong],
    ["Skipped", result.skipped],
    ["Total Questions", result.totalQuestions],
  ].filter(([, value]) => typeof value === "number" && Number.isFinite(value));

  if (rows.length === 0) {
    els.resultExtraInfo.hidden = true;
    return;
  }
  els.resultExtraInfo.hidden = false;
  els.resultExtraInfoList.innerHTML = rows
    .map(([label, value]) => `<div class="result-extra-info-row"><span>${escapeHtml(label)}</span><span>${value}</span></div>`)
    .join("");
}

function renderScorePanel(result, rs, finalScore) {
  const min = typeof rs.minScore === "number" ? rs.minScore : FALLBACK_RESULT_SETTINGS.minScore;
  const max = typeof rs.maxScore === "number" ? rs.maxScore : FALLBACK_RESULT_SETTINGS.maxScore;
  const hasPassingScore = typeof rs.passingScore === "number" && Number.isFinite(rs.passingScore);
  const passingScore = hasPassingScore ? rs.passingScore : FALLBACK_RESULT_SETTINGS.passingScore;

  els.scoreRangeValue.textContent = `${min} – ${max} points`;
  els.jftScoreBig.innerHTML = `${finalScore} <span class="jft-score-unit">points</span>`;
  els.scoreRangeMinLabel.textContent = String(min);
  els.scoreRangeMaxLabel.textContent = String(max);
  els.scorePassingLabel.textContent = hasPassingScore ? `Passing Score: ${passingScore}` : "";
  // Gracefully omit the passing-score indicator entirely if this test
  // genuinely has none configured, rather than inventing a position for it.
  els.scorePassingMarker.style.display = hasPassingScore ? "" : "none";
  els.scorePassingLabel.style.display = hasPassingScore ? "" : "none";

  const span = max - min;
  const clampPct = (v) => (span > 0 ? Math.min(100, Math.max(0, ((v - min) / span) * 100)) : 0);
  const passingPct = clampPct(passingScore);
  const scorePct = clampPct(finalScore);

  requestAnimationFrame(() => {
    els.scoreFailZone.style.width = `${passingPct}%`;
    els.scorePassZone.style.left = `${passingPct}%`;
    els.scorePassZone.style.width = `${100 - passingPct}%`;
    els.scorePassingMarker.style.left = `${passingPct}%`;
    els.scoreStudentMarker.style.left = `${scorePct}%`;
  });
  els.scoreStudentMarkerValue.textContent = String(finalScore);

  const passed = !!result.passed;
  els.jftPassFailBadge.innerHTML = passed
    ? '<span class="jft-pass-fail-ja">合格</span><span class="jft-pass-fail-en">PASSED</span>'
    : '<span class="jft-pass-fail-ja">不合格</span><span class="jft-pass-fail-en">NOT PASSED</span>';
  els.jftPassFailBadge.classList.add(passed ? "pass" : "fail");
  els.scoreStudentMarker.classList.add(passed ? "pass" : "fail");

  els.resultMessageJa.textContent = passed ? (rs.passedJa || FALLBACK_RESULT_SETTINGS.passedJa) : (rs.failedJa || FALLBACK_RESULT_SETTINGS.failedJa);
  els.resultMessageEn.textContent = passed ? (rs.passedEn || FALLBACK_RESULT_SETTINGS.passedEn) : (rs.failedEn || FALLBACK_RESULT_SETTINGS.failedEn);
}

function renderSectionResults(sections, rs) {
  els.sectionResultsList.innerHTML = "";
  const labels = rs.sectionLabels || {};

  sections.forEach((s) => {
    const label = labels[s.sectionId] || { ja: "", en: s.sectionId };
    const item = document.createElement("div");
    item.className = "section-result-item";
    item.innerHTML = `
      <div class="section-result-header">
        <span class="section-result-name">
          ${label.ja ? `<span class="section-result-name-ja">${escapeHtml(label.ja)}</span>` : ""}
          <span class="section-result-name-en">${escapeHtml(label.en || s.sectionId)}</span>
        </span>
        <span class="section-result-percentage">${s.percentage}%</span>
      </div>
      <div class="section-result-bar-track">
        <div class="section-result-bar-fill" data-target-width="${s.percentage}"></div>
        <span class="section-result-bar-dot" data-target-left="${s.percentage}"></span>
      </div>
      <p class="section-result-detail">Questions: ${s.totalQuestions} · Correct: ${s.correct} · Points: ${s.earnedPoints} / ${s.availablePoints}</p>
    `;
    els.sectionResultsList.appendChild(item);
  });

  requestAnimationFrame(() => {
    els.sectionResultsList.querySelectorAll("[data-target-width]").forEach((elm) => {
      elm.style.width = `${elm.dataset.targetWidth}%`;
    });
    els.sectionResultsList.querySelectorAll("[data-target-left]").forEach((elm) => {
      elm.style.left = `${elm.dataset.targetLeft}%`;
    });
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function bindEvents() {
  els.resultBackBtn.addEventListener("click", () => {
    window.location.href = "index.html";
  });
  els.reviewAnswersBtn.addEventListener("click", () => {
    // Carry the same query params through so review.html can load the
    // same attempt (?attemptId=...) and skip the auth gate the same way
    // this page did (?adminPreview=1) — see review.js's init().
    window.location.href = `review.html${window.location.search}`;
  });
  els.resultFullscreenBtn.addEventListener("click", handleResultFullscreenClick);
  els.resultZoomOutBtn.addEventListener("click", zoomOut);
  els.resultZoomInBtn.addEventListener("click", zoomIn);
}

/* =========================================================
   ZOOM — adaptive, same approach as exam.js/review.js: native
   browser pinch/page zoom is used whenever this page is NOT in
   Fullscreen API fullscreen (the viewport meta already permits it
   — see result.html). The application-level CSS-zoom system below
   (via the shared --exam-zoom custom property, scoped to
   #resultZoomContent in css/result.css) is used ONLY while
   fullscreen IS active, because Android Chrome/Firefox/Edge ignore
   the viewport meta's zoom settings entirely for the duration of
   Fullscreen API fullscreen — a real, still-current platform
   limitation, not something fixable via meta/CSS/JS alone.
   ========================================================= */
const ZOOM_LEVELS = [80, 90, 100, 110, 120, 130, 140, 150];
/** This page's own default/baseline zoom — intentionally denser than
 * exam.js/review.js's shared 100% default, per an explicit request for
 * a more compact result view. Used both as the initial value below and
 * as what a genuine fullscreen-exit resets back to (see
 * updateZoomModeForFullscreen) — so 80% is this page's real baseline in
 * every circumstance, not just a one-time starting value. A user's own
 * +/- adjustment during the session is never overwritten by anything
 * here — only a real fullscreen transition ever touches zoomLevel again
 * after this. */
const DEFAULT_ZOOM_LEVEL = 80;
let zoomLevel = DEFAULT_ZOOM_LEVEL;

function applyZoom() {
  document.documentElement.style.setProperty("--exam-zoom", String(zoomLevel / 100));
  els.resultZoomLevelText.textContent = `${zoomLevel}%`;
  els.resultZoomOutBtn.disabled = zoomLevel <= ZOOM_LEVELS[0];
  els.resultZoomInBtn.disabled = zoomLevel >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
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
// +/- buttons use — see utils.js's initPinchZoom. Only ever RUNNING
// while fullscreen is active (started/torn down below), same
// reasoning as exam.js/review.js.
let resultPinchZoomHandle = null;

/** Same role as exam.js's updateZoomModeForFullscreen() — see there for the full rationale. */
function updateZoomModeForFullscreen() {
  const isFullscreen = !!document.fullscreenElement;
  if (els.resultZoomControls) els.resultZoomControls.hidden = !isFullscreen;
  if (isFullscreen) {
    if (!resultPinchZoomHandle) {
      resultPinchZoomHandle = initPinchZoom({
        getLevel: () => zoomLevel,
        setLevel: (n) => { zoomLevel = n; applyZoom(); },
        levels: ZOOM_LEVELS,
      });
    }
  } else {
    if (resultPinchZoomHandle) {
      resultPinchZoomHandle.teardown();
      resultPinchZoomHandle = null;
    }
    if (zoomLevel !== DEFAULT_ZOOM_LEVEL) {
      zoomLevel = DEFAULT_ZOOM_LEVEL;
      applyZoom();
    }
  }
}
document.addEventListener("fullscreenchange", updateZoomModeForFullscreen);
updateZoomModeForFullscreen();
// Apply the initial zoom level immediately — updateZoomModeForFullscreen()
// above only calls applyZoom() when zoomLevel actually differs from its
// own reset target, which is never true on a fresh page load (zoomLevel
// already starts at DEFAULT_ZOOM_LEVEL). Without this, the CSS variable
// would sit at its :root fallback (100%) until some later interaction.
applyZoom();

/* =========================================================
   FULLSCREEN REQUIREMENT — same reused pattern as exam.js's
   examFullscreenModal / review.js's reviewFullscreenModal, built on
   the same shared initFullscreenGuard(). Applied unconditionally to
   every result view (including admin preview), same as review.js —
   see that file's own comment for why this isn't tied to the
   original test's per-test securitySettings. Previously missing
   entirely on this page — a student could exit fullscreen right
   after submitting and view their score without ever being asked to
   return, even though both the exam itself and the review page
   already enforced it.
   ========================================================= */
function resultFullscreenIsAvailable() {
  return document.fullscreenEnabled !== false && typeof document.documentElement.requestFullscreen === "function";
}

function openResultFullscreenRequirement(isInitial) {
  els.resultFullscreenText.textContent = isInitial
    ? "Fullscreen is required to view your result."
    : "Fullscreen is required to continue viewing your result.";
  els.resultFullscreenBtn.textContent = isInitial ? "Enter Fullscreen" : "Return to Fullscreen";
  els.resultFullscreenError.hidden = true;
  if (!els.resultFullscreenModal.open) els.resultFullscreenModal.showModal();
}

async function handleResultFullscreenClick() {
  els.resultFullscreenError.hidden = true;
  if (resultFullscreenGuard) await resultFullscreenGuard.requestFullscreen();
  if (document.fullscreenElement) {
    els.resultFullscreenModal.close();
  } else {
    els.resultFullscreenError.hidden = false;
  }
}

/** Called once the result content has been rendered — a browser/webview
 * without Fullscreen API support is never permanently blocked from a
 * requirement it has no way to satisfy. */
function ensureResultFullscreen() {
  if (!resultFullscreenIsAvailable()) return;
  resultFullscreenGuard = initFullscreenGuard(() => openResultFullscreenRequirement(false));
  if (!document.fullscreenElement) openResultFullscreenRequirement(true);
}

init();
