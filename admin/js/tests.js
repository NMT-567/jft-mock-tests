/**
 * tests.js
 * Controller for admin/tests.html — publish/unpublish/delete of Supabase
 * test rows (spec §9/§10), plus "Preview as User" (spec §8). Publishing
 * itself happens from editor.html (see admin/js/publish.js) — this page
 * only manages status of what's already there and previews it.
 */
import { requireAdminSession } from "./adminAuth.js?v=1";
import { supabase } from "../../js/supabaseClient.js?v=1";
import { listSupabaseTests, setTestStatus, deleteSupabaseTest } from "./publish.js?v=4";
import { hidePageLoader, initThemeToggle, stampYear } from "../../js/utils.js?v=4";
import { showToast, confirmDialog } from "./components.js?v=3";

const els = {
  mainContent: document.getElementById("mainContent"),
  darkModeToggle: document.getElementById("darkModeToggle"),
  testSearchInput: document.getElementById("testSearchInput"),
  testsTableBody: document.getElementById("testsTableBody"),
  testsEmptyState: document.getElementById("testsEmptyState"),
  previewAsDialog: document.getElementById("previewAsDialog"),
  previewAsSelect: document.getElementById("previewAsSelect"),
  cancelPreviewAsBtn: document.getElementById("cancelPreviewAsBtn"),
  confirmPreviewAsBtn: document.getElementById("confirmPreviewAsBtn"),
};

let allTests = [];
let allUsers = [];
let previewAsTestId = null;

async function init() {
  stampYear();
  initThemeToggle(els.darkModeToggle);

  const admin = await requireAdminSession(els.mainContent);
  if (!admin) {
    hidePageLoader();
    return;
  }

  bindEvents();
  await loadData();
  hidePageLoader();
}

async function loadData() {
  try {
    const [tests, { data: users }] = await Promise.all([
      listSupabaseTests(),
      supabase.from("users").select("id, email, display_name").eq("status", "active").order("email"),
    ]);
    allTests = tests;
    allUsers = users || [];
    render();
  } catch (err) {
    showToast(`Failed to load tests: ${err.message || err}`, "error");
  }
}

function bindEvents() {
  els.testSearchInput.addEventListener("input", render);
  els.cancelPreviewAsBtn.addEventListener("click", () => els.previewAsDialog.close());
  els.previewAsDialog.addEventListener("click", (e) => {
    if (e.target === els.previewAsDialog) els.previewAsDialog.close();
  });
  els.confirmPreviewAsBtn.addEventListener("click", () => {
    const email = els.previewAsSelect.value;
    const url = `../exam.html?testId=${encodeURIComponent(previewAsTestId)}&preview=1${email ? `&previewAs=${encodeURIComponent(email)}` : ""}`;
    window.open(url, "_blank");
    els.previewAsDialog.close();
  });
}

function render() {
  const term = els.testSearchInput.value.trim().toLowerCase();
  const filtered = allTests.filter((t) => !term || t.title.toLowerCase().includes(term));
  els.testsEmptyState.hidden = allTests.length > 0;
  els.testsTableBody.innerHTML = "";

  filtered.forEach((test) => {
    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px solid var(--color-border)";
    const statusColor = { published: "#1e9e5a", draft: "#c98a1e", archived: "#888" }[test.status] || "#888";

    tr.innerHTML = `
      <td style="padding:10px 8px;">
        <div>${escapeHtml(test.title)}</div>
        <div style="color:var(--color-text-muted); font-size:0.8rem;">${escapeHtml(test.category_name || "")}</div>
      </td>
      <td style="padding:10px 8px;">${test.total_questions || "—"}</td>
      <td style="padding:10px 8px;">${test.total_points || "—"}</td>
      <td style="padding:10px 8px;">
        <span style="color:${statusColor}; font-weight:600; text-transform:capitalize;">${test.status}</span>
      </td>
      <td style="padding:10px 8px; display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn-secondary btn-sm preview-btn">Preview</button>
        <button type="button" class="btn btn-secondary btn-sm preview-as-btn">Preview as User</button>
        ${test.status === "published"
          ? `<button type="button" class="btn btn-ghost btn-sm unpublish-btn">Unpublish</button>`
          : `<button type="button" class="btn btn-secondary btn-sm publish-btn">Publish</button>`}
        <button type="button" class="btn btn-ghost btn-sm delete-btn">Delete</button>
      </td>
    `;

    tr.querySelector(".preview-btn").addEventListener("click", () => {
      window.open(`../exam.html?testId=${encodeURIComponent(test.id)}&preview=1`, "_blank");
    });
    tr.querySelector(".preview-as-btn").addEventListener("click", () => openPreviewAsDialog(test.id));
    tr.querySelector(".unpublish-btn")?.addEventListener("click", () => changeStatus(test.id, "archived"));
    tr.querySelector(".publish-btn")?.addEventListener("click", () => changeStatus(test.id, "published"));
    tr.querySelector(".delete-btn").addEventListener("click", () => handleDelete(test));

    els.testsTableBody.appendChild(tr);
  });
}

function openPreviewAsDialog(testId) {
  previewAsTestId = testId;
  els.previewAsSelect.innerHTML = `<option value="">— No specific user (just my own admin preview) —</option>`;
  allUsers.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.email;
    opt.textContent = `${u.display_name || u.email} (${u.email})`;
    els.previewAsSelect.appendChild(opt);
  });
  els.previewAsDialog.showModal();
}

async function changeStatus(testId, status) {
  try {
    await setTestStatus(testId, status);
    showToast(status === "published" ? "Published" : "Unpublished", "success");
    await loadData();
  } catch (err) {
    showToast(`Failed: ${err.message || err}`, "error");
  }
}

async function handleDelete(test) {
  const confirmed = await confirmDialog(`Delete "${test.title}" from Supabase? Students will immediately lose access. This does not delete your local editor draft.`, { confirmLabel: "Delete" });
  if (!confirmed) return;
  try {
    await deleteSupabaseTest(test.id);
    showToast("Deleted", "success");
    await loadData();
  } catch (err) {
    showToast(`Failed: ${err.message || err}`, "error");
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

init();
