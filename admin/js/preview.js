/**
 * preview.js
 * Renders a whole GROUP read-only — section banner, shared passage/
 * conversation/media block, and every question in the group with its
 * correct answer highlighted — reusing js/groupRenderer.js so this can
 * never visually drift from what students actually see in js/exam.js.
 */
import { buildSharedBlock, buildQuestionBlock } from "../../js/groupRenderer.js?v=8";
import { flattenDraftQuestions } from "./export.js?v=9";
import { resolveGroupQuestions } from "./questionBank.js?v=4";

/**
 * Render one group (with its questions) read-only into a container.
 * @param {HTMLElement} container
 * @param {object} group - draft group shape { id, type, title, passageText, speakerA/BName/Text, imageUrl, audioUrl, questions: [{id}] } — questions are bank REFERENCES, resolved internally.
 * @param {{ startOrder?: number }} opts - the global question number of the group's first question (for Q labels)
 */
export function renderGroupPreview(container, group, { startOrder = 1 } = {}) {
  container.innerHTML = "";

  if (!group || !group.questions || group.questions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<h2>Nothing to preview yet</h2><p>Add a question to see it here.</p>";
    container.appendChild(empty);
    return;
  }

  const resolved = resolveGroupQuestions(group);

  const sharedBlock = buildSharedBlock(group);
  if (sharedBlock) container.appendChild(sharedBlock);

  const list = document.createElement("div");
  list.className = "question-block-list";
  resolved.questions.forEach((q, idx) => {
    list.appendChild(buildQuestionBlock(q, startOrder + idx, group, { readOnly: true }));
  });
  container.appendChild(list);
}

/** Get the full flattened, globally-numbered question list for a draft (delegates to export.js so preview and export never disagree). */
export function getPreviewQuestions(draft) {
  return flattenDraftQuestions(draft);
}

/* =========================================================
   STANDALONE PAGE CONTROLLER (preview.html only)
   ========================================================= */
const pageRoot = document.getElementById("previewRoot");
if (pageRoot) {
  initFullPreviewPage(pageRoot);
}

async function initFullPreviewPage(root) {
  const { loadDraft } = await import("./storage.js?v=3");
  const { hidePageLoader, getQueryParam } = await import("../../js/utils.js?v=6");

  const id = getQueryParam("id");
  const draft = id ? loadDraft(id) : null;

  const titleEl = document.getElementById("previewTestTitle");
  const progressEl = document.getElementById("previewProgressText");
  const sectionBanner = document.getElementById("sectionBanner");
  const sectionBannerIndex = document.getElementById("sectionBannerIndex");
  const sectionBannerTitle = document.getElementById("sectionBannerTitle");
  const prevBtn = document.getElementById("previewPrevBtn");
  const nextBtn = document.getElementById("previewNextBtn");

  if (!draft) {
    root.innerHTML = "";
    root.appendChild(
      Object.assign(document.createElement("div"), {
        className: "empty-state",
        innerHTML: "<h2>No test found</h2><p>Go back to the editor and try Preview again.</p>",
      })
    );
    hidePageLoader();
    return;
  }

  titleEl.textContent = draft.title || "Untitled Test";

  // Build the same "pages" (one per group, with section context) that
  // js/loader.js builds for the real exam, so Next/Previous here matches
  // the real Next/Previous-moves-between-groups behavior exactly.
  const pages = [];
  const flatQuestions = getPreviewQuestions(draft);
  let order = 0;
  (draft.sections || []).forEach((section, sectionIndex) => {
    (section.groups || []).forEach((group) => {
      const startOrder = order + 1;
      order += group.questions.length;
      pages.push({ group, section, sectionIndex, startOrder });
    });
  });

  let pageIndex = 0;
  let lastSectionIndex = -1;

  function render() {
    if (pages.length === 0) {
      root.innerHTML = "";
      root.appendChild(
        Object.assign(document.createElement("div"), {
          className: "empty-state",
          innerHTML: "<h2>No questions yet</h2><p>Add sections and questions in the editor to preview them here.</p>",
        })
      );
      progressEl.textContent = "";
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    const page = pages[pageIndex];

    if (page.sectionIndex !== lastSectionIndex) {
      lastSectionIndex = page.sectionIndex;
      sectionBanner.hidden = false;
      sectionBannerIndex.textContent = `Section ${page.sectionIndex + 1} of ${draft.sections.length}`;
      sectionBannerTitle.textContent = page.section.title;
    } else {
      sectionBanner.hidden = true;
    }

    renderGroupPreview(root, page.group, { startOrder: page.startOrder });

    const endOrder = page.startOrder + page.group.questions.length - 1;
    progressEl.textContent =
      endOrder > page.startOrder ? `Question ${page.startOrder}-${endOrder} of ${flatQuestions.length}` : `Question ${page.startOrder} of ${flatQuestions.length}`;
    prevBtn.disabled = pageIndex === 0;
    nextBtn.disabled = pageIndex === pages.length - 1;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  prevBtn.addEventListener("click", () => {
    if (pageIndex > 0) {
      pageIndex -= 1;
      render();
    }
  });
  nextBtn.addEventListener("click", () => {
    if (pageIndex < pages.length - 1) {
      pageIndex += 1;
      render();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") prevBtn.click();
    if (e.key === "ArrowRight") nextBtn.click();
  });

  render();
  hidePageLoader();
}
