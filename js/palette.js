/**
 * palette.js
 * Renders and updates the question palette grid. Still one button per
 * individual question (per spec — the palette must show every question
 * number even though navigation now moves by group), so clicking a
 * button hands the question's id back to exam.js, which is responsible
 * for switching to the right group page and scrolling to that question.
 */

/**
 * @param {HTMLElement} gridEl
 * @param {Array} questionIndex - test.questionIndex from loader.js (flat, globally-numbered)
 * @param {(questionId:string)=>void} onJump
 */
export function renderPalette(gridEl, questionIndex, onJump) {
  gridEl.innerHTML = "";
  questionIndex.forEach((entry) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-item status-not-visited";
    btn.textContent = String(entry.order);
    btn.dataset.questionId = entry.id;
    btn.setAttribute("aria-label", `Go to question ${entry.order}`);
    btn.addEventListener("click", () => onJump(entry.id));
    gridEl.appendChild(btn);
  });
}

/**
 * Update the visual state of every palette button. `currentPageIndex`
 * highlights every question belonging to the group currently on screen
 * (a group can hold several questions at once).
 */
export function updatePaletteState(gridEl, { questionIndex, answers, visited, bookmarks, currentPageIndex }) {
  const buttons = gridEl.querySelectorAll(".palette-item");
  buttons.forEach((btn, i) => {
    const entry = questionIndex[i];
    const isAnswered = Object.prototype.hasOwnProperty.call(answers, entry.id) && answers[entry.id] !== null && answers[entry.id] !== undefined;
    const isVisited = visited.includes(entry.id);
    const isBookmarked = bookmarks.includes(entry.id);

    btn.classList.remove("status-not-visited", "status-visited", "status-answered", "current", "bookmarked");

    if (isAnswered) btn.classList.add("status-answered");
    else if (isVisited) btn.classList.add("status-visited");
    else btn.classList.add("status-not-visited");

    if (isBookmarked) btn.classList.add("bookmarked");
    if (entry.pageIndex === currentPageIndex) btn.classList.add("current");
  });
}

/** Compute answered / unanswered / bookmarked counts across ALL questions (for summary displays). */
export function computeSummary(questionIndex, answers, bookmarks) {
  let answeredCount = 0;
  questionIndex.forEach((entry) => {
    if (Object.prototype.hasOwnProperty.call(answers, entry.id) && answers[entry.id] !== null && answers[entry.id] !== undefined) {
      answeredCount += 1;
    }
  });
  return {
    answered: answeredCount,
    unanswered: questionIndex.length - answeredCount,
    bookmarked: bookmarks.length,
  };
}

/** Answered/unanswered count restricted to ONE group's questions (used to gate "Next" on listening groups). */
export function computeGroupCompletion(group, answers) {
  const total = group.questions.length;
  const answered = group.questions.filter((q) => answers[q.id] !== null && answers[q.id] !== undefined).length;
  return { total, answered, complete: answered === total };
}
