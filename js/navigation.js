/**
 * navigation.js
 * Keyboard navigation and question-jump helpers shared by exam.js.
 */

/**
 * Wire up Left/Right arrow key navigation.
 * Ignores key presses while the user is typing into a text/search field
 * (e.g. the question-search box) so arrow keys still work for text editing.
 * @param {()=>void} onPrev
 * @param {()=>void} onNext
 */
export function bindArrowKeyNavigation(onPrev, onNext) {
  const handler = (event) => {
    const tag = (event.target && event.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onPrev();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onNext();
    }
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

/** Resolve a 1-based question-number search input into the matching question id, or null if invalid. */
export function resolveJumpQuestionId(rawValue, questionIndex) {
  const n = parseInt(rawValue, 10);
  if (Number.isNaN(n)) return null;
  const entry = questionIndex.find((e) => e.order === n);
  return entry ? entry.id : null;
}

/**
 * Wire up a "swipe down to close" touch gesture on a bottom-sheet element,
 * dragged from its handle. Follows the finger while dragging (translateY)
 * and either snaps back or calls onClose depending on drag distance.
 * @param {HTMLElement} handleEl - the drag-handle element to listen on
 * @param {HTMLElement} sheetEl - the sheet element to translate while dragging
 * @param {()=>void} onClose - called when the drag exceeds the close threshold
 */
export function bindSwipeToClose(handleEl, sheetEl, onClose) {
  const CLOSE_THRESHOLD_PX = 90;
  let startY = 0;
  let currentY = 0;
  let dragging = false;

  const onTouchStart = (e) => {
    dragging = true;
    startY = e.touches[0].clientY;
    sheetEl.style.transition = "none";
  };

  const onTouchMove = (e) => {
    if (!dragging) return;
    currentY = e.touches[0].clientY;
    const delta = Math.max(0, currentY - startY);
    sheetEl.style.transform = `translateY(${delta}px)`;
  };

  const onTouchEnd = () => {
    if (!dragging) return;
    dragging = false;
    sheetEl.style.transition = "";
    const delta = Math.max(0, currentY - startY);
    if (delta > CLOSE_THRESHOLD_PX) {
      onClose();
    }
    sheetEl.style.transform = "";
  };

  handleEl.addEventListener("touchstart", onTouchStart, { passive: true });
  handleEl.addEventListener("touchmove", onTouchMove, { passive: true });
  handleEl.addEventListener("touchend", onTouchEnd);

  return () => {
    handleEl.removeEventListener("touchstart", onTouchStart);
    handleEl.removeEventListener("touchmove", onTouchMove);
    handleEl.removeEventListener("touchend", onTouchEnd);
  };
}
