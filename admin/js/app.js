/**
 * app.js
 * Controller for admin/index.html — the dashboard.
 */
import { listDrafts, saveDraft, deleteDraft, getLastOpenedDraftId, getSettings, saveSettings } from "./storage.js?v=3";
import { el, generateId, showToast, formatUpdatedAt, confirmDialog } from "./components.js?v=3";
import { hidePageLoader, initThemeToggle, stampYear } from "../../js/utils.js?v=5";

const els = {
  darkModeToggle: document.getElementById("darkModeToggle"),
  createTestBtn: document.getElementById("createTestBtn"),
  openExistingBtn: document.getElementById("openExistingBtn"),

  recentTestsList: document.getElementById("recentTestsList"),

  settingsModal: document.getElementById("settingsModal"),
  autoSaveToggle: document.getElementById("autoSaveToggle"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  preferencesBtn: document.getElementById("preferencesBtn"),
};

function init() {
  stampYear();
  initThemeToggle(els.darkModeToggle);
  renderRecentTests();
  bindEvents();
  hidePageLoader();
}

function renderRecentTests() {
  const index = listDrafts();
  const entries = Object.values(index).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  els.recentTestsList.innerHTML = "";

  if (entries.length === 0) {
    els.recentTestsList.appendChild(el("p", { class: "empty-recent", text: "No tests yet — create or import one to get started." }));
    return;
  }

  entries.forEach((entry) => {
    const row = el("div", { class: "recent-test-row", onclick: () => openDraft(entry.id) }, [
      el("div", { class: "recent-test-info" }, [
        el("p", { class: "recent-test-title", text: entry.title || "Untitled Test" }),
        el("p", { class: "recent-test-meta", text: `${entry.category || "General"} · ${entry.questionCount} question${entry.questionCount === 1 ? "" : "s"} · Updated ${formatUpdatedAt(entry.updatedAt)}` }),
      ]),
      el("div", { class: "recent-test-actions" }, [
        el("button", {
          type: "button",
          class: "btn btn-secondary",
          text: "Open",
          onclick: (e) => {
            e.stopPropagation();
            openDraft(entry.id);
          },
        }),
        el("button", {
          type: "button",
          class: "btn btn-ghost",
          text: "Delete",
          onclick: async (e) => {
            e.stopPropagation();
            const confirmed = await confirmDialog(`Delete "${entry.title || "Untitled Test"}"? This cannot be undone.`);
            if (confirmed) {
              deleteDraft(entry.id);
              renderRecentTests();
              showToast("Deleted");
            }
          },
        }),
      ]),
    ]);
    els.recentTestsList.appendChild(row);
  });
}

function openDraft(id) {
  window.location.href = `editor.html?id=${encodeURIComponent(id)}`;
}

function createNewTest() {
  const draft = {
    id: generateId("test"),
    title: "",
    categoryName: "",
    topic: "",
    description: "",
    language: "en",
    duration: 60,
    noTimeLimit: false,
    passMarks: null,
    active: true,
    premium: false,
    status: "draft",
    createdAt: new Date().toISOString(),
    sections: [],
  };
  saveDraft(draft);
  openDraft(draft.id);
}

function bindEvents() {
  els.createTestBtn.addEventListener("click", createNewTest);

  els.openExistingBtn.addEventListener("click", () => {
    const lastId = getLastOpenedDraftId();
    const index = listDrafts();
    if (lastId && index[lastId]) {
      openDraft(lastId);
    } else {
      document.getElementById("recentTestsSection")?.scrollIntoView({ behavior: "smooth" });
    }
  });

  els.preferencesBtn.addEventListener("click", () => {
    const settings = getSettings();
    els.autoSaveToggle.classList.toggle("on", settings.autoSaveEnabled !== false);
    els.settingsModal.showModal();
  });
  els.closeSettingsBtn.addEventListener("click", () => els.settingsModal.close());
  els.autoSaveToggle.addEventListener("click", () => {
    const settings = getSettings();
    settings.autoSaveEnabled = settings.autoSaveEnabled === false;
    saveSettings(settings);
    els.autoSaveToggle.classList.toggle("on", settings.autoSaveEnabled !== false);
  });
}

init();
