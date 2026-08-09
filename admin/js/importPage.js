/**
 * importPage.js
 * Controller for import.html — a single linear flow (no nested
 * dropdowns): pick a file, see a full preview of exactly what will be
 * created, choose New/Replace, resolve any Question Bank id collisions,
 * then import and see the source-vs-imported integrity report.
 */
import { hidePageLoader, initThemeToggle } from "../../js/utils.js?v=5";
import { saveDraft, listDrafts } from "./storage.js?v=3";
import { el, showToast, formatUpdatedAt } from "./components.js?v=3";
import { buildImportPlan, commitImportPlan, runIntegrityCheck, FIXED_SECTIONS } from "./importAnalyze.js?v=1";
import { importDocumentToDraft, importLegacyV1Test } from "./import.js?v=6";

const els = {
  darkModeToggle: document.getElementById("darkModeToggle"),

  importDropZone: document.getElementById("importDropZone"),
  importFileInput: document.getElementById("importFileInput"),
  validationErrors: document.getElementById("validationErrors"),
  validationErrorList: document.getElementById("validationErrorList"),

  previewFileName: document.getElementById("previewFileName"),
  previewStatGrid: document.getElementById("previewStatGrid"),
  previewSectionBreakdown: document.getElementById("previewSectionBreakdown"),
  previewWarningsBlock: document.getElementById("previewWarningsBlock"),
  previewWarningsList: document.getElementById("previewWarningsList"),
  previewImageConflictsBlock: document.getElementById("previewImageConflictsBlock"),
  previewImageConflictsList: document.getElementById("previewImageConflictsList"),
  previewCollisionsBlock: document.getElementById("previewCollisionsBlock"),
  previewCollisionsList: document.getElementById("previewCollisionsList"),
  previewAmbiguousBlock: document.getElementById("previewAmbiguousBlock"),
  previewAmbiguousList: document.getElementById("previewAmbiguousList"),
  replaceTargetList: document.getElementById("replaceTargetList"),
  previewCancelBtn: document.getElementById("previewCancelBtn"),
  previewImportBtn: document.getElementById("previewImportBtn"),

  sourceReportList: document.getElementById("sourceReportList"),
  importedReportList: document.getElementById("importedReportList"),
  dataLossLine: document.getElementById("dataLossLine"),
  duplicatesLine: document.getElementById("duplicatesLine"),
  mismatchBlock: document.getElementById("mismatchBlock"),
  mismatchList: document.getElementById("mismatchList"),
  successAmbiguousBlock: document.getElementById("successAmbiguousBlock"),
  successAmbiguousList: document.getElementById("successAmbiguousList"),
  openImportedTestBtn: document.getElementById("openImportedTestBtn"),
};

let currentPlan = null;
let currentFileName = "";
let replaceTargetId = null;
let committedDraft = null;

function init() {
  initThemeToggle(els.darkModeToggle);
  bindEvents();
  hidePageLoader();
}

function showStep(step) {
  document.getElementById("uploadStep").hidden = step !== "upload";
  document.getElementById("previewStep").hidden = step !== "preview";
  document.getElementById("successStep").hidden = step !== "success";
  document.querySelectorAll(".import-step").forEach((s) => {
    s.classList.toggle("active", s.dataset.step === step);
    s.classList.toggle("done", (step === "preview" && s.dataset.step === "upload") || (step === "success" && s.dataset.step !== "success"));
  });
}

/* =========================================================
   UPLOAD + VALIDATE
   ========================================================= */
async function handleFile(file) {
  currentFileName = file.name;
  els.validationErrors.hidden = true;

  let text;
  try {
    text = await file.text();
  } catch (err) {
    showValidationErrors(["Couldn't read that file."]);
    return;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    showValidationErrors(["That file isn't valid JSON."]);
    return;
  }

  // Files already in this admin's own v2 export shape (sections[] at the
  // top level — e.g. re-importing a file this admin exported earlier)
  // need none of the passage/section-detection below: there's nothing
  // ambiguous to preview, every group/section is already explicit. Same
  // for the old pre-Question-Bank v1 shape when its records carry the
  // groupId/groupType round-trip metadata the old admin used to write —
  // both go straight through, matching the previous (now-retired) quick
  // import modal's behavior for these two shapes.
  if (Array.isArray(json.sections)) {
    quickImport(() => importDocumentToDraft(json));
    return;
  }
  if (Array.isArray(json.tests)) {
    if (json.tests.length === 0) {
      showValidationErrors(["This file's tests[] array is empty — there's nothing to import."]);
      return;
    }
    const test = json.tests[0];
    const hasLegacyGroupMeta = Array.isArray(test.questions) && test.questions.some((q) => q.groupId && q.groupType);
    if (hasLegacyGroupMeta) {
      quickImport(() => importLegacyV1Test(test));
      return;
    }
    // The shape this page's spec is actually about: tests[].questions[]
    // with no explicit grouping — passage headers and sections need to
    // be detected, so this DOES get the full preview.
    const plan = buildImportPlan(json);
    if (!plan.valid) {
      showValidationErrors(plan.errors);
      return;
    }
    currentPlan = plan;
    renderPreview(plan);
    showStep("preview");
    return;
  }

  const foundKeys = Object.keys(json).slice(0, 6).join(", ") || "(empty object)";
  showValidationErrors([`This file has neither a sections[] nor a tests[] array — found: ${foundKeys}.`]);
}

/** Already-unambiguous shapes (clean v2 re-import, or legacy v1 with its own round-trip group metadata) skip the passage/section preview entirely — there's nothing in them that needs a judgment call. */
function quickImport(buildDraft) {
  let draft;
  try {
    draft = buildDraft();
  } catch (err) {
    showValidationErrors([err.message || "Import failed."]);
    return;
  }
  saveDraft(draft);
  showToast(`Imported "${draft.title}"`, "success");
  window.location.href = `editor.html?id=${encodeURIComponent(draft.id)}`;
}

function showValidationErrors(errors) {
  els.validationErrorList.innerHTML = "";
  errors.forEach((e) => els.validationErrorList.appendChild(el("li", { text: e })));
  els.validationErrors.hidden = false;
}

/* =========================================================
   PREVIEW
   ========================================================= */
function statBox(label, value) {
  return el("div", { class: "stat-box" }, [el("span", { class: "stat-label", text: label }), el("span", { class: "stat-value", text: String(value) })]);
}

function renderPreview(plan) {
  els.previewFileName.textContent = `${currentFileName} — "${plan.sourceTest.title || "Untitled Test"}"`;

  els.previewStatGrid.innerHTML = "";
  [
    ["Questions", plan.stats.realQuestions],
    ["Sections", FIXED_SECTIONS.length],
    ["Passage Groups", plan.stats.passageGroups],
    ["Listening", plan.stats.listeningQuestions],
    ["With Image", plan.stats.imageQuestions],
    ["Audio Files", plan.stats.audioFiles],
  ].forEach(([label, value]) => els.previewStatGrid.appendChild(statBox(label, value)));

  els.previewSectionBreakdown.innerHTML = "";
  FIXED_SECTIONS.forEach((fs) => {
    const count = plan.stats.perSection[fs.key];
    els.previewSectionBreakdown.appendChild(
      el("div", { class: "import-section-row" }, [
        el("span", { class: "import-section-row-title", text: fs.title }),
        el("span", { class: "import-section-row-count", text: `${count} question${count === 1 ? "" : "s"}` }),
      ])
    );
  });

  els.previewWarningsBlock.hidden = plan.warnings.length === 0;
  els.previewWarningsList.innerHTML = "";
  plan.warnings.forEach((w) => els.previewWarningsList.appendChild(el("li", { text: w })));

  els.previewImageConflictsBlock.hidden = plan.imageConflicts.length === 0;
  els.previewImageConflictsList.innerHTML = "";
  plan.imageConflicts.forEach((c) => {
    els.previewImageConflictsList.appendChild(el("li", { text: `Q ${c.questionId} — "${(c.question || "").slice(0, 60)}"` }));
  });

  els.previewCollisionsBlock.hidden = plan.existingBankCollisions.length === 0;
  els.previewCollisionsList.innerHTML = "";
  plan.existingBankCollisions.forEach((c) => {
    els.previewCollisionsList.appendChild(el("li", { text: `"${c.id}" already exists in the Question Bank.` }));
  });

  els.previewAmbiguousBlock.hidden = plan.ambiguous.length === 0;
  els.previewAmbiguousList.innerHTML = "";
  plan.ambiguous.forEach((a) => {
    const sectionTitle = FIXED_SECTIONS.find((fs) => fs.key === a.assignedSection)?.title || a.assignedSection;
    els.previewAmbiguousList.appendChild(el("li", { text: `"${(a.question || "").slice(0, 60)}" — assigned to ${sectionTitle}, no strong signal either way.` }));
  });

  renderReplaceTargetList();
}

function renderReplaceTargetList() {
  const index = listDrafts();
  const entries = Object.values(index).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  els.replaceTargetList.innerHTML = "";
  replaceTargetId = null;

  if (entries.length === 0) {
    els.replaceTargetList.appendChild(el("p", { class: "empty-recent", text: "No existing tests to replace yet." }));
    return;
  }
  entries.forEach((entry, i) => {
    const radio = el("input", { type: "radio", name: "replaceTarget", value: entry.id, checked: i === 0 ? "" : null });
    radio.addEventListener("change", () => { replaceTargetId = entry.id; });
    if (i === 0) replaceTargetId = entry.id;
    els.replaceTargetList.appendChild(
      el("label", { class: "dialog-radio-option" }, [radio, el("span", { text: `${entry.title || "Untitled Test"} — ${entry.questionCount} question${entry.questionCount === 1 ? "" : "s"}, updated ${formatUpdatedAt(entry.updatedAt)}` })])
    );
  });
}

/* =========================================================
   COMMIT
   ========================================================= */
async function performImport() {
  const mode = document.querySelector('input[name="importMode"]:checked').value;
  if (mode === "replace" && !replaceTargetId) {
    showToast("No existing test selected to replace.", "error");
    return;
  }
  const duplicateResolutionInput = document.querySelector('input[name="duplicateResolution"]:checked');
  const duplicateResolution = duplicateResolutionInput ? duplicateResolutionInput.value : "use-existing";

  els.previewImportBtn.disabled = true;
  els.previewImportBtn.textContent = "Importing…";

  const { draft, idRemap } = commitImportPlan(currentPlan, { mode, existingDraftId: replaceTargetId, duplicateResolution });
  saveDraft(draft);
  committedDraft = draft;

  const report = runIntegrityCheck(currentPlan, draft, idRemap);
  renderSuccess(report);
  showStep("success");

  els.previewImportBtn.disabled = false;
  els.previewImportBtn.textContent = "Import";
}

/* =========================================================
   SUCCESS
   ========================================================= */
function reportRow(label, value) {
  return el("li", {}, [el("span", { text: label }), el("span", { text: String(value) })]);
}

function renderSuccess(report) {
  els.sourceReportList.innerHTML = "";
  [
    ["Tests", report.sourceCounts.tests],
    ["Questions", report.sourceCounts.questions],
    ["Passage Groups", report.sourceCounts.passageGroups],
    ["Images", report.sourceCounts.images],
    ["Audio", report.sourceCounts.audio],
  ].forEach(([l, v]) => els.sourceReportList.appendChild(reportRow(l, v)));

  els.importedReportList.innerHTML = "";
  [
    ["Tests", report.importedCounts.tests],
    ["Questions", report.importedCounts.questions],
    ["Passage Groups", report.importedCounts.passageGroups],
    ["Images", report.importedCounts.images],
    ["Audio", report.importedCounts.audio],
  ].forEach(([l, v]) => els.importedReportList.appendChild(reportRow(l, v)));

  const dataLossCount = report.dataLoss + report.knownImageConflicts.length;
  els.dataLossLine.textContent = `DATA LOSS: ${dataLossCount}`;
  els.dataLossLine.className = `import-report-line ${dataLossCount === 0 ? "ok" : "bad"}`;
  els.duplicatesLine.textContent = `DUPLICATES: ${report.duplicates}`;
  els.duplicatesLine.className = `import-report-line ${report.duplicates === 0 ? "ok" : "bad"}`;

  const allIssues = [
    ...report.mismatches.map((m) => `Q ${m.id} — ${m.field}: source "${JSON.stringify(m.source)}" ≠ imported "${JSON.stringify(m.imported)}"`),
    ...report.knownImageConflicts.map((c) => `Q ${c.questionId} — its own image (${c.ownImageUrl.slice(-30)}) isn't attached; only the passage group's shared image was kept.`),
  ];
  els.mismatchBlock.hidden = allIssues.length === 0;
  els.mismatchList.innerHTML = "";
  allIssues.forEach((m) => els.mismatchList.appendChild(el("li", { text: m })));

  els.successAmbiguousBlock.hidden = currentPlan.ambiguous.length === 0;
  els.successAmbiguousList.innerHTML = "";
  currentPlan.ambiguous.forEach((a) => {
    const sectionTitle = FIXED_SECTIONS.find((fs) => fs.key === a.assignedSection)?.title || a.assignedSection;
    els.successAmbiguousList.appendChild(el("li", { text: `"${(a.question || "").slice(0, 60)}" — in ${sectionTitle}, please confirm.` }));
  });
}

/* =========================================================
   EVENTS
   ========================================================= */
function bindEvents() {
  els.importDropZone.addEventListener("click", () => els.importFileInput.click());
  els.importFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
  });
  els.importDropZone.addEventListener("dragover", (e) => { e.preventDefault(); els.importDropZone.classList.add("drag-active"); });
  els.importDropZone.addEventListener("dragleave", () => els.importDropZone.classList.remove("drag-active"));
  els.importDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.importDropZone.classList.remove("drag-active");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  document.querySelectorAll('input[name="importMode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const mode = document.querySelector('input[name="importMode"]:checked').value;
      els.replaceTargetList.hidden = mode !== "replace";
    });
  });

  els.previewCancelBtn.addEventListener("click", () => { window.location.href = "index.html"; });
  els.previewImportBtn.addEventListener("click", performImport);

  els.openImportedTestBtn.addEventListener("click", () => {
    if (committedDraft) window.location.href = `editor.html?id=${encodeURIComponent(committedDraft.id)}`;
  });
}

init();
