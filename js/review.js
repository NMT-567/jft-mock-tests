/**
 * review.js
 * Controller for review.html — displays every question with the student's
 * answer, correct answer, explanation, and supports filter + search.
 */
import { loadResult } from "./storage.js?v=7";
import { supabase } from "./supabaseClient.js?v=1";
import { requireAuth } from "./auth.js?v=4";
import { hidePageLoader, initThemeToggle, renderRichText, escapeHtml, debounce, getQueryParam } from "./utils.js?v=5";

const els = {
  darkModeToggle: document.getElementById("darkModeToggle"),
  backToResultBtn: document.getElementById("backToResultBtn"),
  filterChips: document.querySelectorAll(".filter-chip"),
  reviewSearchInput: document.getElementById("reviewSearchInput"),
  reviewList: document.getElementById("reviewList"),
};

let result = null;
let activeFilter = "all";
let searchTerm = "";

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

  els.filterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      els.filterChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeFilter = chip.dataset.filter;
      renderList();
    });
  });

  els.reviewSearchInput.addEventListener(
    "input",
    debounce(() => {
      searchTerm = els.reviewSearchInput.value.trim();
      renderList();
    }, 150)
  );
}

function matchesFilter(answer) {
  switch (activeFilter) {
    case "correct":
      return answer.isCorrect;
    case "wrong":
      return !answer.isCorrect && answer.givenOption !== null;
    case "skipped":
      return answer.givenOption === null;
    case "bookmarked":
      return answer.bookmarked;
    default:
      return true;
  }
}

function matchesSearch(answer) {
  if (!searchTerm) return true;
  return String(answer.order) === searchTerm.replace(/^#/, "");
}

function renderList() {
  const filtered = result.answers.filter((a) => matchesFilter(a) && matchesSearch(a));

  if (filtered.length === 0) {
    els.reviewList.innerHTML = `<div class="review-empty">No questions match this filter.</div>`;
    return;
  }

  els.reviewList.innerHTML = filtered.map(renderReviewItem).join("");
}

function renderReviewItem(answer) {
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

  return `
    <article class="card review-item">
      <div class="review-item-header">
        <span class="review-item-badge ${statusClass}">Q${answer.order} · ${statusLabel}</span>
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
