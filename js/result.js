/**
 * result.js
 * Controller for result.html — renders the JFT-style score report from the
 * last completed attempt stored by exam.js via storage.js. All numbers
 * (final score, section percentages, pass/fail) were already computed by
 * exam.js at submission time and saved verbatim on the `result` object —
 * this file only renders them, it never recalculates scoring itself, so
 * there's exactly one place the scoring logic lives.
 */
import { loadResult } from "./storage.js?v=7";
import { supabase } from "./supabaseClient.js?v=1";
import { requireAuth } from "./auth.js?v=4";
import { hidePageLoader, initThemeToggle, stampYear, getQueryParam } from "./utils.js?v=5";
import { initContentProtection } from "./security.js?v=5";

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
  returnHomeBtn: document.getElementById("returnHomeBtn"),
};

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
    els.reviewAnswersBtn.disabled = true;
    hidePageLoader();
    return;
  }

  render(result);
  bindEvents();
  if (els.resultMain) initContentProtection(els.resultMain);
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

function render(result) {
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

  renderScorePanel(result, rs, finalScore);
  renderSectionResults(sections, rs);
}

function renderScorePanel(result, rs, finalScore) {
  const min = typeof rs.minScore === "number" ? rs.minScore : FALLBACK_RESULT_SETTINGS.minScore;
  const max = typeof rs.maxScore === "number" ? rs.maxScore : FALLBACK_RESULT_SETTINGS.maxScore;
  const passingScore = typeof rs.passingScore === "number" ? rs.passingScore : FALLBACK_RESULT_SETTINGS.passingScore;

  els.scoreRangeValue.textContent = `${min} – ${max} points`;
  els.jftScoreBig.innerHTML = `${finalScore} <span class="jft-score-unit">points</span>`;
  els.scoreRangeMinLabel.textContent = String(min);
  els.scoreRangeMaxLabel.textContent = String(max);
  els.scorePassingLabel.textContent = `Passing Score: ${passingScore}`;

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
  els.reviewAnswersBtn.addEventListener("click", () => {
    // Carry the same query params through so review.html can load the
    // same attempt (?attemptId=...) and skip the auth gate the same way
    // this page did (?adminPreview=1) — see review.js's init().
    window.location.href = `review.html${window.location.search}`;
  });
  els.returnHomeBtn.addEventListener("click", () => {
    window.location.href = "index.html";
  });
}

init();
