/**
 * settings.js
 * Controller for admin/settings.html. Loads the current data/settings.json,
 * lets the admin edit every field visually, and offers a download of the
 * updated file (there's no backend, so — same as the test JSON export —
 * applying a change means replacing data/settings.json in the repo).
 *
 * The `password` field this used to manage (a casual click-through gate
 * on the old login.html) was removed in Session 15/16 — login.html now
 * uses real Google OAuth via Supabase, and nothing reads settings.json's
 * password anymore. Old settings.json files with a leftover `password`
 * key are harmless (just ignored), and this page no longer writes one.
 */
import { readFileAsDataUrl, showToast } from "./components.js?v=3";
import { hidePageLoader, initThemeToggle } from "../../js/utils.js?v=6";

const DEFAULTS = {
  siteTitle: "Nihongo Mock Test",
  logoUrl: null,
  themeColor: "#1e88e5",
  timerDefaultMinutes: 60,
  passingMarksDefault: 200,
};

const els = {
  darkModeToggle: document.getElementById("darkModeToggle"),
  siteTitleInput: document.getElementById("siteTitleInput"),
  logoInput: document.getElementById("logoInput"),
  logoPreview: document.getElementById("logoPreview"),
  logoClearBtn: document.getElementById("logoClearBtn"),
  themeColorInput: document.getElementById("themeColorInput"),
  themeColorTextInput: document.getElementById("themeColorTextInput"),
  timerDefaultInput: document.getElementById("timerDefaultInput"),
  passingMarksInput: document.getElementById("passingMarksInput"),
  downloadSettingsBtn: document.getElementById("downloadSettingsBtn"),
};

let current = { ...DEFAULTS };

async function init() {
  initThemeToggle(els.darkModeToggle);

  try {
    const response = await fetch("../data/settings.json", { cache: "no-store" });
    const loaded = await response.json();
    current = { ...DEFAULTS, ...loaded };
    delete current.password; // drop any leftover password key from an old settings.json — never re-written
  } catch (err) {
    showToast("Could not load current settings.json — showing defaults", "error");
  }

  populateForm();
  bindEvents();
  hidePageLoader();
}

function populateForm() {
  els.siteTitleInput.value = current.siteTitle || "";
  els.themeColorInput.value = current.themeColor || DEFAULTS.themeColor;
  els.themeColorTextInput.value = current.themeColor || DEFAULTS.themeColor;
  els.timerDefaultInput.value = current.timerDefaultMinutes ?? "";
  els.passingMarksInput.value = current.passingMarksDefault ?? "";
  renderLogoPreview();
}

function renderLogoPreview() {
  if (current.logoUrl) {
    els.logoPreview.src = current.logoUrl;
    els.logoPreview.hidden = false;
    els.logoClearBtn.hidden = false;
  } else {
    els.logoPreview.hidden = true;
    els.logoClearBtn.hidden = true;
  }
}

function bindEvents() {
  els.siteTitleInput.addEventListener("input", (e) => { current.siteTitle = e.target.value; });

  els.logoInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    current.logoUrl = await readFileAsDataUrl(file);
    renderLogoPreview();
  });
  els.logoClearBtn.addEventListener("click", () => {
    current.logoUrl = null;
    renderLogoPreview();
  });

  els.themeColorInput.addEventListener("input", (e) => {
    current.themeColor = e.target.value;
    els.themeColorTextInput.value = e.target.value;
  });
  els.themeColorTextInput.addEventListener("input", (e) => {
    current.themeColor = e.target.value;
    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) els.themeColorInput.value = e.target.value;
  });

  els.timerDefaultInput.addEventListener("input", (e) => { current.timerDefaultMinutes = e.target.value === "" ? null : Number(e.target.value); });
  els.passingMarksInput.addEventListener("input", (e) => { current.passingMarksDefault = e.target.value === "" ? null : Number(e.target.value); });

  els.downloadSettingsBtn.addEventListener("click", downloadSettings);
}

function downloadSettings() {
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "settings.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Downloaded settings.json — replace data/settings.json in your repo to apply it", "success");
}

init();
