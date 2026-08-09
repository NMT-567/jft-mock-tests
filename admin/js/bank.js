/**
 * bank.js
 * Controller for admin/bank.html — browse, search, filter, create, edit,
 * duplicate, and delete Question Bank entries directly (no test context
 * needed). Editing a question here is the same underlying operation as
 * editing it inline in editor.js's cards — both write straight to the
 * bank via saveBankEntry, so changes are visible everywhere the question
 * is referenced.
 */
import { el, generateId, showToast, readFileAsDataUrl, confirmDialog } from "./components.js?v=3";
import { hidePageLoader, initThemeToggle, debounce } from "../../js/utils.js?v=6";
import { newBankEntry, listBankEntries, saveBankEntry, deleteBankEntry, computeUsageDetails } from "./questionBank.js?v=4";

const FREQUENT_THRESHOLD = 3;

const els = {
  darkModeToggle: document.getElementById("darkModeToggle"),
  bankCountLabel: document.getElementById("bankCountLabel"),
  newQuestionBtn: document.getElementById("newQuestionBtn"),
  bankSearchInput: document.getElementById("bankSearchInput"),
  bankFiltersPanel: document.getElementById("bankFiltersPanel"),
  bankTagFilterRow: document.getElementById("bankTagFilterRow"),
  clearFiltersBtn: document.getElementById("clearFiltersBtn"),
  bankListPanel: document.getElementById("bankListPanel"),
  deleteWarningModal: document.getElementById("deleteWarningModal"),
  deleteWarningText: document.getElementById("deleteWarningText"),
  cancelDeleteBtn: document.getElementById("cancelDeleteBtn"),
  confirmDeleteAnywayBtn: document.getElementById("confirmDeleteAnywayBtn"),
};

let searchTerm = "";
const filters = { status: null, jlpt: null, difficulty: null, section: null, type: null, tag: null };
const expandedIds = new Set();
let pendingDeleteId = null;

function init() {
  initThemeToggle(els.darkModeToggle);
  bindEvents();
  render();
  hidePageLoader();
}

function render() {
  const usage = computeUsageDetails();
  renderTagFilterRow();
  renderList(usage);
}

function renderTagFilterRow() {
  const allTags = new Set();
  listBankEntries().forEach((e) => (e.tags || []).forEach((t) => allTags.add(t)));
  els.bankTagFilterRow.innerHTML = "";
  if (allTags.size === 0) {
    els.bankTagFilterRow.appendChild(el("p", { class: "bank-usage-note", text: "No tags yet." }));
    return;
  }
  [...allTags].sort().forEach((tag) => {
    const chip = el("button", { type: "button", class: "filter-chip" + (filters.tag === tag ? " active" : ""), text: tag });
    chip.addEventListener("click", () => {
      filters.tag = filters.tag === tag ? null : tag;
      render();
    });
    els.bankTagFilterRow.appendChild(chip);
  });
}

function matchesFilters(entry, usageForEntry) {
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    const haystack = [entry.id, entry.question, entry.explanation, ...(entry.tags || [])].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(term)) return false;
  }
  const count = usageForEntry?.count || 0;
  if (filters.status === "bookmarked" && !entry.bookmarked) return false;
  if (filters.status === "favorite" && !entry.favorite) return false;
  if (filters.status === "unused" && count > 0) return false;
  if (filters.status === "frequent" && count < FREQUENT_THRESHOLD) return false;
  if (filters.jlpt && entry.jlptLevel !== filters.jlpt) return false;
  if (filters.difficulty && entry.difficulty !== filters.difficulty) return false;
  if (filters.section && ![...(usageForEntry?.sectionTitles || [])].some((t) => t.includes(filters.section))) return false;
  if (filters.type && !([...(usageForEntry?.groupTypes || [])].includes(filters.type))) return false;
  if (filters.tag && !(entry.tags || []).includes(filters.tag)) return false;
  return true;
}

function renderList(usage) {
  const all = listBankEntries();
  els.bankCountLabel.textContent = `${all.length} question${all.length === 1 ? "" : "s"}`;

  const filtered = all.filter((entry) => matchesFilters(entry, usage[entry.id]));
  els.bankListPanel.innerHTML = "";

  if (filtered.length === 0) {
    els.bankListPanel.appendChild(el("div", { class: "empty-state" }, [el("h2", { text: "No questions match" }), el("p", { text: all.length === 0 ? "Create your first question to get started." : "Try adjusting your search or filters." })]));
    return;
  }

  filtered.forEach((entry) => {
    els.bankListPanel.appendChild(buildBankCard(entry, usage[entry.id]));
  });
}

function buildBankCard(entry, usageInfo) {
  const isExpanded = expandedIds.has(entry.id);
  const card = el("div", { class: "bank-card" + (entry.bookmarked ? " bookmarked" : "") });

  const summary = el("div", { class: "bank-card-summary", onclick: () => toggleExpanded(entry.id) }, [
    el("span", { class: "bank-card-summary-text", text: entry.question || "(untitled question)" }),
  ]);
  const badges = el("div", { class: "bank-card-badges" });
  if (entry.jlptLevel) badges.appendChild(el("span", { class: "bank-badge jlpt", text: entry.jlptLevel }));
  if (entry.difficulty) badges.appendChild(el("span", { class: `bank-badge difficulty-${entry.difficulty}`, text: entry.difficulty }));
  badges.appendChild(el("span", { class: "bank-badge usage", text: `Used ${usageInfo?.count || 0}×` }));
  if (entry.status === "archived") badges.appendChild(el("span", { class: "bank-badge", text: "Archived" }));
  summary.appendChild(badges);

  const iconActions = el("div", { class: "bank-card-icon-actions" }, [
    iconBtn(entry.bookmarked ? "★" : "☆", "Bookmark", (e) => { e.stopPropagation(); saveBankEntry({ ...entry, bookmarked: !entry.bookmarked }); render(); }),
    iconBtn(entry.favorite ? "♥" : "♡", "Favorite", (e) => { e.stopPropagation(); saveBankEntry({ ...entry, favorite: !entry.favorite }); render(); }),
    iconBtn("⧉", "Duplicate", (e) => { e.stopPropagation(); duplicateEntry(entry); }),
    iconBtn("✕", "Delete", (e) => { e.stopPropagation(); requestDelete(entry, usageInfo); }),
  ]);
  summary.appendChild(iconActions);
  card.appendChild(summary);

  const detail = el("div", { class: "bank-card-detail" + (isExpanded ? "" : " hidden") });
  if (isExpanded) buildDetailForm(detail, entry, usageInfo);
  card.appendChild(detail);

  return card;
}

function iconBtn(glyph, ariaLabel, onClick) {
  return el("button", { type: "button", class: "icon-btn icon-btn-xs", "aria-label": ariaLabel, text: glyph, onclick: onClick });
}

function toggleExpanded(id) {
  if (expandedIds.has(id)) expandedIds.delete(id);
  else expandedIds.add(id);
  render();
}

function buildDetailForm(container, entry, usageInfo) {
  const questionTa = el("textarea", { class: "text-input", placeholder: "Question text" });
  questionTa.value = entry.question || "";
  questionTa.addEventListener("input", (e) => saveBankEntry({ ...entry, question: e.target.value }));
  container.appendChild(labeledMini("Question", questionTa));

  container.appendChild(buildOptionsEditor(entry));

  const explTa = el("textarea", { class: "text-input" });
  explTa.style.minHeight = "50px";
  explTa.value = entry.explanation || "";
  explTa.addEventListener("input", (e) => saveBankEntry({ ...entry, explanation: e.target.value }));
  container.appendChild(labeledMini("Explanation", explTa));

  const row1 = el("div", { class: "field-row" });
  row1.appendChild(labeledMini("Marks", numberInput(entry.marks, (v) => saveBankEntry({ ...entry, marks: v }))));
  row1.appendChild(labeledMini("Difficulty", selectInput(entry.difficulty, [["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]], (v) => saveBankEntry({ ...entry, difficulty: v }))));
  container.appendChild(row1);

  const row2 = el("div", { class: "field-row" });
  row2.appendChild(labeledMini("JLPT Level", selectInput(entry.jlptLevel || "", [["", "—"], ["N5", "N5"], ["N4", "N4"], ["N3", "N3"], ["N2", "N2"], ["N1", "N1"]], (v) => saveBankEntry({ ...entry, jlptLevel: v || null }))));
  row2.appendChild(labeledMini("JFT Category", selectInput(entry.category || "", [["", "—"], ["Scripts & Vocabulary", "Scripts & Vocabulary"], ["Conversation & Expression", "Conversation & Expression"], ["Listening", "Listening"], ["Reading", "Reading"]], (v) => saveBankEntry({ ...entry, category: v || null }))));
  container.appendChild(row2);

  container.appendChild(labeledMini("Image (optional)", buildUploadRow(entry, "imageUrl", "image")));
  container.appendChild(labeledMini("Audio (optional)", buildUploadRow(entry, "audioUrl", "audio")));

  container.appendChild(labeledMini("Tags", buildTagEditor(entry)));

  const statusRow = el("div", { class: "field-checkbox" });
  const statusCheckbox = el("input", { type: "checkbox", checked: entry.status === "archived" ? "" : null });
  statusCheckbox.addEventListener("change", (e) => saveBankEntry({ ...entry, status: e.target.checked ? "archived" : "active" }));
  statusRow.appendChild(statusCheckbox);
  statusRow.appendChild(document.createTextNode("Archived (hidden from normal use, not deleted)"));
  container.appendChild(statusRow);

  if (usageInfo && usageInfo.count > 0) {
    container.appendChild(
      el("p", { class: "bank-usage-note", text: `Used in: ${[...usageInfo.testTitles].filter(Boolean).join(", ") || "unknown test(s)"} (${usageInfo.count} placement${usageInfo.count === 1 ? "" : "s"}). Editing this question updates it everywhere it's used.` })
    );
  } else {
    container.appendChild(el("p", { class: "bank-usage-note", text: "Not currently used in any test." }));
  }

  container.appendChild(
    el("p", { class: "bank-usage-note", text: `Created ${formatDate(entry.createdAt)} · Modified ${formatDate(entry.modifiedAt)} · ID: ${entry.id}` })
  );
}

function formatDate(iso) {
  if (!iso) return "unknown";
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (err) {
    return iso;
  }
}

function labeledMini(label, control) {
  return el("div", { class: "field-group" }, [el("label", { class: "field-label", text: label }), control]);
}
function numberInput(value, onChange) {
  const input = el("input", { type: "number", class: "text-input", value: value ?? "" });
  input.addEventListener("input", (e) => onChange(e.target.value === "" ? null : Number(e.target.value)));
  return input;
}
function selectInput(value, options, onChange) {
  const select = el("select", { class: "text-input" });
  options.forEach(([val, label]) => select.appendChild(el("option", { value: val, text: label, selected: val === value ? "" : null })));
  select.addEventListener("change", (e) => onChange(e.target.value));
  return select;
}

function buildOptionsEditor(entry) {
  const wrap = el("div", {});
  const options = entry.options && entry.options.length >= 4 ? entry.options.slice(0, 4) : [...(entry.options || []), "", "", "", ""].slice(0, 4);
  const letters = ["A", "B", "C", "D"];
  letters.forEach((letter, idx) => {
    const radio = el("input", {
      type: "radio", name: `correct-${entry.id}`,
      checked: entry.correctOption && entry.correctOption === options[idx] && options[idx] !== "" ? "" : null,
      onchange: () => saveBankEntry({ ...entry, correctOption: options[idx] }),
    });
    const input = el("input", { type: "text", class: "text-input", placeholder: `Option ${letter}`, value: options[idx] || "" });
    input.addEventListener("input", (e) => {
      const oldValue = options[idx];
      const newOptions = [...options];
      newOptions[idx] = e.target.value;
      const patch = { options: newOptions };
      if (entry.correctOption === oldValue) patch.correctOption = e.target.value;
      saveBankEntry({ ...entry, ...patch });
      options[idx] = e.target.value;
      if (entry.correctOption === oldValue) entry.correctOption = e.target.value;
    });
    wrap.appendChild(el("div", { class: "option-row" }, [radio, el("span", { class: "option-letter", text: letter }), input]));
  });
  return wrap;
}

function buildUploadRow(entry, field, accept) {
  const row = el("div", { class: "upload-row" });
  const input = el("input", {
    type: "file", accept: accept === "audio" ? "audio/*" : "image/*",
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await readFileAsDataUrl(file);
      saveBankEntry({ ...entry, [field]: dataUrl });
      render();
    },
  });
  row.appendChild(input);
  if (entry[field]) {
    row.appendChild(accept === "audio" ? el("audio", { controls: "", src: entry[field], style: "height:32px;" }) : el("img", { class: "upload-preview", src: entry[field], alt: "Uploaded preview" }));
    row.appendChild(el("button", { type: "button", class: "upload-clear-btn", text: "Remove", onclick: () => { saveBankEntry({ ...entry, [field]: null }); render(); } }));
  }
  return row;
}

function buildTagEditor(entry) {
  const wrap = el("div", { class: "bank-tag-input-row" });
  const tags = entry.tags || [];
  tags.forEach((tag) => {
    wrap.appendChild(
      el("span", { class: "bank-tag-chip" }, [
        document.createTextNode(tag),
        el("button", { type: "button", "aria-label": `Remove tag ${tag}`, text: "×", onclick: () => { saveBankEntry({ ...entry, tags: tags.filter((t) => t !== tag) }); render(); } }),
      ])
    );
  });
  const input = el("input", { type: "text", class: "bank-tag-add-input", placeholder: "Add tag, press Enter" });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      e.preventDefault();
      const newTag = input.value.trim();
      if (!tags.includes(newTag)) {
        saveBankEntry({ ...entry, tags: [...tags, newTag] });
        render();
      }
      input.value = "";
    }
  });
  wrap.appendChild(input);
  return wrap;
}

function createNewQuestion() {
  const entry = newBankEntry();
  saveBankEntry(entry, { touchModified: false });
  expandedIds.add(entry.id);
  render();
  requestAnimationFrame(() => {
    document.querySelector(".bank-card-detail textarea")?.focus();
  });
}

function duplicateEntry(entry) {
  const clone = newBankEntry({ ...entry, id: generateId("bq") });
  saveBankEntry(clone, { touchModified: false });
  showToast("Duplicated as a new bank question");
  render();
}

function requestDelete(entry, usageInfo) {
  if (usageInfo && usageInfo.count > 0) {
    pendingDeleteId = entry.id;
    els.deleteWarningText.textContent = `This question is used in ${usageInfo.count} place${usageInfo.count === 1 ? "" : "s"} (${[...usageInfo.testTitles].filter(Boolean).join(", ") || "unknown tests"}). Deleting it will leave a broken reference in those tests — you'll need to remove it from them separately.`;
    els.deleteWarningModal.showModal();
    return;
  }
  confirmDialog(`Delete "${entry.question || "this question"}" permanently? This cannot be undone.`, { confirmLabel: "Delete" }).then((confirmed) => {
    if (confirmed) {
      deleteBankEntry(entry.id);
      showToast("Deleted");
      render();
    }
  });
}

function bindEvents() {
  els.newQuestionBtn.addEventListener("click", createNewQuestion);
  els.bankSearchInput.addEventListener("input", debounce((e) => { searchTerm = e.target.value.trim(); render(); }, 150));

  document.querySelectorAll(".bank-filters .filter-chip[data-status]").forEach((chip) => {
    chip.addEventListener("click", () => toggleFilterChip(chip, "status"));
  });
  document.querySelectorAll(".bank-filters .filter-chip[data-jlpt]").forEach((chip) => {
    chip.addEventListener("click", () => toggleFilterChip(chip, "jlpt"));
  });
  document.querySelectorAll(".bank-filters .filter-chip[data-difficulty]").forEach((chip) => {
    chip.addEventListener("click", () => toggleFilterChip(chip, "difficulty"));
  });
  document.querySelectorAll(".bank-filters .filter-chip[data-section]").forEach((chip) => {
    chip.addEventListener("click", () => toggleFilterChip(chip, "section"));
  });
  document.querySelectorAll(".bank-filters .filter-chip[data-type]").forEach((chip) => {
    chip.addEventListener("click", () => toggleFilterChip(chip, "type"));
  });

  els.clearFiltersBtn.addEventListener("click", () => {
    Object.keys(filters).forEach((k) => (filters[k] = null));
    searchTerm = "";
    els.bankSearchInput.value = "";
    document.querySelectorAll(".bank-filters .filter-chip").forEach((c) => c.classList.remove("active"));
    render();
  });

  els.cancelDeleteBtn.addEventListener("click", () => { pendingDeleteId = null; els.deleteWarningModal.close(); });
  els.confirmDeleteAnywayBtn.addEventListener("click", () => {
    if (pendingDeleteId) {
      deleteBankEntry(pendingDeleteId);
      showToast("Deleted (references left dangling — remove from tests separately)");
      pendingDeleteId = null;
    }
    els.deleteWarningModal.close();
    render();
  });
}

function toggleFilterChip(chip, category) {
  const value = chip.dataset[category];
  const isActive = filters[category] === value;
  document.querySelectorAll(`.bank-filters .filter-chip[data-${category}]`).forEach((c) => c.classList.remove("active"));
  if (isActive) {
    filters[category] = null;
  } else {
    filters[category] = value;
    chip.classList.add("active");
  }
  render();
}

init();
