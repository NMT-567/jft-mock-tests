/**
 * users.js
 * Controller for admin/users.html — student access management: the
 * original allowlist/per-test-access screen (spec §2/§14/§15 from an
 * earlier session), now upgraded with expiring access, bulk management,
 * and automatic access expiration (this session's spec).
 *
 * IMPORTANT — where the real enforcement lives: nothing in this file is
 * the actual security boundary. Every write here either goes through
 * RLS (public.users_admin_all, unchanged) or one of the new SECURITY
 * DEFINER RPCs added in supabase/migrations/0008_access_expiration.sql
 * (admin_add_student/admin_extend_access/admin_set_expiration/
 * admin_set_status/admin_remove_access), each of which re-checks
 * is_admin(auth.uid()) itself. The actual access DECISION for students
 * is made entirely by public.is_active_user(uid) (same migration),
 * which every existing RLS policy and the get_exam_content()/
 * submit-attempt authorization paths already funnel through — this
 * page only calls the RPCs and displays what the database returns.
 * Session revocation still calls the existing admin-revoke-session Edge
 * Function (the one place the service-role key is used, unchanged).
 */
import { requireAdminSession } from "./adminAuth.js?v=2";
import { supabase } from "../../js/supabaseClient.js?v=1";
import { hidePageLoader, initThemeToggle, stampYear } from "../../js/utils.js?v=6";
import { showToast, confirmDialog } from "./components.js?v=3";

// Single authoritative "expiring soon" threshold (spec §19) — nowhere
// else in this file (or anywhere else in the project) hard-codes this
// number; every "Expiring Soon" decision reads this one constant.
const EXPIRING_SOON_DAYS = 7;

const els = {
  mainContent: document.getElementById("mainContent"),
  darkModeToggle: document.getElementById("darkModeToggle"),
  addStudentEmailInput: document.getElementById("addStudentEmailInput"),
  addStudentDaysInput: document.getElementById("addStudentDaysInput"),
  addStudentQuickDays: document.getElementById("addStudentQuickDays"),
  addStudentBtn: document.getElementById("addStudentBtn"),
  addStudentMessage: document.getElementById("addStudentMessage"),
  accessSummaryGrid: document.getElementById("accessSummaryGrid"),
  accessFilterChips: document.getElementById("accessFilterChips"),
  userSearchInput: document.getElementById("userSearchInput"),
  userSortSelect: document.getElementById("userSortSelect"),
  userCount: document.getElementById("userCount"),
  selectAllCheckbox: document.getElementById("selectAllCheckbox"),
  bulkActionToolbar: document.getElementById("bulkActionToolbar"),
  bulkSelectedCount: document.getElementById("bulkSelectedCount"),
  bulkExtendBtn: document.getElementById("bulkExtendBtn"),
  bulkSetExpirationBtn: document.getElementById("bulkSetExpirationBtn"),
  bulkEnableBtn: document.getElementById("bulkEnableBtn"),
  bulkDisableBtn: document.getElementById("bulkDisableBtn"),
  bulkRevokeBtn: document.getElementById("bulkRevokeBtn"),
  bulkRemoveBtn: document.getElementById("bulkRemoveBtn"),
  usersTableBody: document.getElementById("usersTableBody"),
  usersEmptyState: document.getElementById("usersEmptyState"),
  accessDialog: document.getElementById("accessDialog"),
  accessDialogTitle: document.getElementById("accessDialogTitle"),
  allowAllToggle: document.getElementById("allowAllToggle"),
  perTestList: document.getElementById("perTestList"),
  closeAccessDialogBtn: document.getElementById("closeAccessDialogBtn"),
  extendAccessDialog: document.getElementById("extendAccessDialog"),
  extendAccessTarget: document.getElementById("extendAccessTarget"),
  extendAccessCurrent: document.getElementById("extendAccessCurrent"),
  extendUnlimitedWarning: document.getElementById("extendUnlimitedWarning"),
  extendDaysInput: document.getElementById("extendDaysInput"),
  extendDurationChoices: document.getElementById("extendDurationChoices"),
  extendAccessPreview: document.getElementById("extendAccessPreview"),
  cancelExtendBtn: document.getElementById("cancelExtendBtn"),
  confirmExtendBtn: document.getElementById("confirmExtendBtn"),
  setExpirationDialog: document.getElementById("setExpirationDialog"),
  setExpirationTitle: document.getElementById("setExpirationTitle"),
  setExpirationTarget: document.getElementById("setExpirationTarget"),
  setExpirationDaysInput: document.getElementById("setExpirationDaysInput"),
  setExpirationQuickDays: document.getElementById("setExpirationQuickDays"),
  removeExpirationBtn: document.getElementById("removeExpirationBtn"),
  cancelSetExpirationBtn: document.getElementById("cancelSetExpirationBtn"),
  confirmSetExpirationBtn: document.getElementById("confirmSetExpirationBtn"),
};

let allUsers = [];
let allInvites = []; // public.invited_students rows with no matching public.users row yet — see loadData()
let allTests = [];
let accessDialogUser = null;
let currentAdmin = null;

let selectedIds = new Set(); // real user ids only — an invite has no user_id yet, so it's never bulk-selectable
let activeFilter = "all"; // all | active | expiring | expired | disabled | never_logged_in | recent
let sortMode = "expires_asc";

let extendTargetIds = [];
let setExpirationTargetIds = [];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECENT_DAYS = 7; // "Recently Added" filter window

async function init() {
  stampYear();
  initThemeToggle(els.darkModeToggle);

  const admin = await requireAdminSession(els.mainContent);
  if (!admin) {
    hidePageLoader();
    return;
  }
  currentAdmin = admin;

  bindEvents();
  await loadData();
  hidePageLoader();
}

async function loadData() {
  const [{ data: users, error: usersErr }, { data: invites, error: invitesErr }, { data: tests, error: testsErr }] = await Promise.all([
    supabase.from("users").select("*").order("created_at", { ascending: false }),
    supabase.from("invited_students").select("*").order("created_at", { ascending: false }),
    supabase.from("tests").select("id, title, status").order("title"),
  ]);
  if (usersErr) {
    showToast(`Failed to load users: ${usersErr.message}`, "error");
    return;
  }
  allUsers = users || [];
  if (invitesErr) {
    console.error(invitesErr);
    allInvites = [];
  } else {
    const realEmails = new Set(allUsers.map((u) => u.email.toLowerCase()));
    allInvites = (invites || []).filter((inv) => !realEmails.has(inv.email.toLowerCase()));
  }
  allTests = (tests || []).filter((t) => t.status !== "archived");
  if (testsErr) console.error(testsErr);
  // Drop any selected id that no longer exists (e.g. after a reload) so the toolbar/count never shows stale state.
  const stillValid = new Set(allUsers.map((u) => u.id));
  selectedIds = new Set([...selectedIds].filter((id) => stillValid.has(id)));
  render();
}

function bindEvents() {
  els.addStudentBtn.addEventListener("click", handleAddStudent);
  els.addStudentEmailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAddStudent();
  });
  els.addStudentQuickDays.querySelectorAll(".duration-choice-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.addStudentQuickDays.querySelectorAll(".duration-choice-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      if (btn.dataset.days !== "unlimited") els.addStudentDaysInput.value = btn.dataset.days;
    });
  });
  // Typing a custom number deselects whichever quick button was active,
  // including Unlimited — typing IS the admin overriding the preset.
  els.addStudentDaysInput.addEventListener("input", () => {
    els.addStudentQuickDays.querySelectorAll(".duration-choice-btn").forEach((b) => b.classList.remove("selected"));
  });

  els.userSearchInput.addEventListener("input", render);
  els.userSortSelect.addEventListener("change", () => {
    sortMode = els.userSortSelect.value;
    render();
  });

  els.selectAllCheckbox.addEventListener("change", () => {
    const visibleIds = getVisibleUsers().map((u) => u.id);
    if (els.selectAllCheckbox.checked) visibleIds.forEach((id) => selectedIds.add(id));
    else visibleIds.forEach((id) => selectedIds.delete(id));
    render();
  });

  els.closeAccessDialogBtn.addEventListener("click", () => els.accessDialog.close());
  els.accessDialog.addEventListener("click", (e) => {
    if (e.target === els.accessDialog) els.accessDialog.close();
  });
  els.allowAllToggle.addEventListener("click", async () => {
    if (!accessDialogUser) return;
    const next = !accessDialogUser.allow_all_tests;
    const { error } = await supabase.from("users").update({ allow_all_tests: next }).eq("id", accessDialogUser.id);
    if (error) {
      showToast(`Failed: ${error.message}`, "error");
      return;
    }
    accessDialogUser.allow_all_tests = next;
    els.allowAllToggle.classList.toggle("on", next);
    renderPerTestList();
    await loadData();
  });

  // Bulk toolbar
  els.bulkExtendBtn.addEventListener("click", () => openExtendDialog([...selectedIds]));
  els.bulkSetExpirationBtn.addEventListener("click", () => openSetExpirationDialog([...selectedIds]));
  els.bulkEnableBtn.addEventListener("click", () => bulkSetStatus("active"));
  els.bulkDisableBtn.addEventListener("click", () => bulkSetStatus("disabled"));
  els.bulkRevokeBtn.addEventListener("click", bulkRevokeSessions);
  els.bulkRemoveBtn.addEventListener("click", bulkRemoveAccess);

  // Extend Access dialog
  els.extendDurationChoices.querySelectorAll(".duration-choice-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.extendDurationChoices.querySelectorAll(".duration-choice-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      els.extendDaysInput.value = btn.dataset.days;
      updateExtendPreview();
    });
  });
  els.extendDaysInput.addEventListener("input", () => {
    els.extendDurationChoices.querySelectorAll(".duration-choice-btn").forEach((b) => b.classList.remove("selected"));
    updateExtendPreview();
  });
  els.cancelExtendBtn.addEventListener("click", () => els.extendAccessDialog.close());
  els.confirmExtendBtn.addEventListener("click", confirmExtend);

  // Set/Change Expiration dialog
  els.setExpirationQuickDays.querySelectorAll(".duration-choice-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.setExpirationQuickDays.querySelectorAll(".duration-choice-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      els.setExpirationDaysInput.value = btn.dataset.days;
    });
  });
  els.setExpirationDaysInput.addEventListener("input", () => {
    els.setExpirationQuickDays.querySelectorAll(".duration-choice-btn").forEach((b) => b.classList.remove("selected"));
  });
  els.removeExpirationBtn.addEventListener("click", confirmRemoveExpiration);
  els.cancelSetExpirationBtn.addEventListener("click", () => els.setExpirationDialog.close());
  els.confirmSetExpirationBtn.addEventListener("click", confirmSetExpiration);
}

/* =========================================================
   ADD STUDENT
   ========================================================= */
async function handleAddStudent() {
  const raw = els.addStudentEmailInput.value.trim();
  const email = raw.toLowerCase();
  setAddStudentMessage("", null);

  if (!raw) {
    setAddStudentMessage("Enter an email address.", "error");
    return;
  }
  if (!EMAIL_RE.test(raw)) {
    setAddStudentMessage("That doesn't look like a valid email address.", "error");
    return;
  }

  const isUnlimited = els.addStudentQuickDays.querySelector('.duration-choice-btn[data-days="unlimited"]')?.classList.contains("selected");
  let pDays = null;
  if (!isUnlimited) {
    const days = Number(els.addStudentDaysInput.value);
    if (!Number.isInteger(days) || days <= 0 || days > 3650) {
      setAddStudentMessage("Please enter a valid number of days.", "error");
      return;
    }
    pDays = days;
  }

  els.addStudentBtn.disabled = true;
  try {
    const { error } = await supabase.rpc("admin_add_student", { p_email: email, p_days: pDays, p_custom_expires_at: null });
    if (error) throw error;
    setAddStudentMessage("Student added — access starts the moment they sign in with Google.", "success");
    els.addStudentEmailInput.value = "";
    await loadData();
  } catch (err) {
    setAddStudentMessage(`Failed: ${err.message || err}`, "error");
  } finally {
    els.addStudentBtn.disabled = false;
  }
}

function setAddStudentMessage(text, kind) {
  els.addStudentMessage.hidden = !text;
  els.addStudentMessage.textContent = text;
  els.addStudentMessage.style.color = kind === "error" ? "#c94141" : kind === "success" ? "#1e9e5a" : "";
}

/* =========================================================
   ACCESS STATUS — the one place ACTIVE/EXPIRING SOON/EXPIRED/
   DISABLED/NO ACCESS is computed. Purely a display-layer read of
   status + access_expires_at; never itself an authorization check
   (see this file's header comment) and never written back anywhere.
   ========================================================= */
function computeAccess(user) {
  if (user.status === "disabled") {
    return { key: "disabled", label: "Disabled", badgeClass: "access-badge-disabled" };
  }
  if (user.status === "pending") {
    return { key: "none", label: "No Access", badgeClass: "access-badge-none" };
  }
  if (!user.access_expires_at) {
    return { key: "active", label: "Active", badgeClass: "access-badge-active", detail: "No expiration" };
  }
  const expiresAt = new Date(user.access_expires_at);
  const now = new Date();
  const msRemaining = expiresAt.getTime() - now.getTime();
  if (msRemaining <= 0) {
    const daysAgo = Math.floor(-msRemaining / 86400000);
    const detail = daysAgo <= 0 ? "Expired today" : daysAgo === 1 ? "Expired yesterday" : `Expired ${daysAgo} days ago`;
    return { key: "expired", label: "Expired", badgeClass: "access-badge-expired", detail };
  }
  const daysRemaining = Math.ceil(msRemaining / 86400000);
  const detail = daysRemaining === 0 ? "Expires today" : daysRemaining === 1 ? "Expires tomorrow" : `Expires in ${daysRemaining} days`;
  if (daysRemaining <= EXPIRING_SOON_DAYS) {
    return { key: "expiring", label: "Expiring Soon", badgeClass: "access-badge-expiring", detail };
  }
  return { key: "active", label: "Active", badgeClass: "access-badge-active", detail };
}

function formatDate(d) {
  return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}
function formatDateTime(d) {
  return new Date(d).toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/* =========================================================
   RENDER
   ========================================================= */
function getVisibleUsers() {
  const term = els.userSearchInput.value.trim().toLowerCase();
  const now = Date.now();
  return allUsers
    .filter((u) => !term || u.email.toLowerCase().includes(term) || (u.display_name || "").toLowerCase().includes(term))
    .filter((u) => {
      if (activeFilter === "all") return true;
      if (activeFilter === "never_logged_in") return !u.last_login_at;
      if (activeFilter === "recent") return u.created_at && now - new Date(u.created_at).getTime() <= RECENT_DAYS * 86400000;
      return computeAccess(u).key === activeFilter;
    });
}

function sortUsers(users) {
  const arr = [...users];
  switch (sortMode) {
    case "name_asc":
      return arr.sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email));
    case "name_desc":
      return arr.sort((a, b) => (b.display_name || b.email).localeCompare(a.display_name || a.email));
    case "email_asc":
      return arr.sort((a, b) => a.email.localeCompare(b.email));
    case "status":
      return arr.sort((a, b) => computeAccess(a).key.localeCompare(computeAccess(b).key));
    case "last_login_desc":
      return arr.sort((a, b) => new Date(b.last_login_at || 0) - new Date(a.last_login_at || 0));
    case "created_desc":
      return arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    case "created_asc":
      return arr.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    case "expires_desc":
      // Unlimited (null) students are never "expired" or "soonest" — they sort as if furthest in the future, first here.
      return arr.sort((a, b) => {
        const ax = a.access_expires_at ? new Date(a.access_expires_at).getTime() : Infinity;
        const bx = b.access_expires_at ? new Date(b.access_expires_at).getTime() : Infinity;
        return bx - ax;
      });
    case "expires_asc":
    default:
      // Nulls (no expiration) sort last — an account with no expiration is never the most urgent to look at.
      return arr.sort((a, b) => {
        const ax = a.access_expires_at ? new Date(a.access_expires_at).getTime() : Infinity;
        const bx = b.access_expires_at ? new Date(b.access_expires_at).getTime() : Infinity;
        return ax - bx;
      });
  }
}

function render() {
  const filteredInvites = allInvites.filter((inv) => {
    const term = els.userSearchInput.value.trim().toLowerCase();
    return !term || inv.email.toLowerCase().includes(term);
  });
  const visibleUsers = sortUsers(getVisibleUsers());

  renderSummary();
  renderFilterChips();

  const totalCount = visibleUsers.length + (activeFilter === "all" ? filteredInvites.length : 0);
  els.userCount.textContent = `${totalCount} user${totalCount === 1 ? "" : "s"}`;
  els.usersEmptyState.hidden = allUsers.length + allInvites.length > 0;
  els.usersTableBody.innerHTML = "";

  if (activeFilter === "all") filteredInvites.forEach((invite) => renderInviteRow(invite));
  visibleUsers.forEach((user) => renderUserRow(user));

  const visibleIds = visibleUsers.map((u) => u.id);
  els.selectAllCheckbox.checked = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  updateBulkToolbar();
}

function renderSummary() {
  const counts = { all: allUsers.length, active: 0, expiring: 0, expired: 0, disabled: 0 };
  allUsers.forEach((u) => {
    const key = computeAccess(u).key;
    if (key === "active" || key === "expiring" || key === "expired" || key === "disabled") counts[key]++;
  });
  const cards = [
    { key: "all", label: "Total Students", count: counts.all },
    { key: "active", label: "Active", count: counts.active },
    { key: "expiring", label: "Expiring Soon", count: counts.expiring },
    { key: "expired", label: "Expired", count: counts.expired },
    { key: "disabled", label: "Disabled", count: counts.disabled },
  ];
  els.accessSummaryGrid.innerHTML = cards
    .map(
      (c) => `
      <div class="access-summary-card${activeFilter === c.key ? " active-filter" : ""}" data-filter="${c.key}">
        <div class="access-summary-card-count">${c.count}</div>
        <div class="access-summary-card-label">${c.label}</div>
      </div>`
    )
    .join("");
  els.accessSummaryGrid.querySelectorAll(".access-summary-card").forEach((card) => {
    card.addEventListener("click", () => {
      activeFilter = card.dataset.filter;
      render();
    });
  });
}

function renderFilterChips() {
  const chips = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "expiring", label: "Expiring Soon" },
    { key: "expired", label: "Expired" },
    { key: "disabled", label: "Disabled" },
    { key: "never_logged_in", label: "Never Logged In" },
    { key: "recent", label: "Recently Added" },
  ];
  els.accessFilterChips.innerHTML = chips
    .map((c) => `<button type="button" class="access-filter-chip${activeFilter === c.key ? " active" : ""}" data-filter="${c.key}">${c.label}</button>`)
    .join("");
  els.accessFilterChips.querySelectorAll(".access-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      activeFilter = chip.dataset.filter;
      render();
    });
  });
}

function avatarCell(avatarUrl, placeholderInitial) {
  if (avatarUrl) {
    return `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:32px; height:32px; border-radius:50%; object-fit:cover; display:block;" />`;
  }
  return `<div style="width:32px; height:32px; border-radius:50%; background:var(--color-border); display:flex; align-items:center; justify-content:center; font-size:0.8rem; color:var(--color-text-muted);">${escapeHtml(placeholderInitial || "?")}</div>`;
}

function renderInviteRow(invite) {
  const tr = document.createElement("tr");
  tr.style.borderBottom = "1px solid var(--color-border)";
  const accessPreview = invite.access_expires_at ? `Grants until ${formatDate(invite.access_expires_at)}` : "Grants unlimited access";
  tr.innerHTML = `
    <td style="padding:10px 8px;"></td>
    <td style="padding:10px 8px;">
      <div style="color:var(--color-text-muted); font-style:italic;">Not signed in yet</div>
      <div style="color:var(--color-text-muted); font-size:0.82rem;">${escapeHtml(invite.email)}</div>
    </td>
    <td style="padding:10px 8px;">
      <span style="color:#888; font-weight:600;">Invited</span>
    </td>
    <td style="padding:10px 8px; font-size:0.82rem; color:var(--color-text-muted);">${escapeHtml(accessPreview)}</td>
    <td style="padding:10px 8px; color:var(--color-text-muted); font-size:0.85rem;">—</td>
    <td style="padding:10px 8px; color:var(--color-text-muted); font-size:0.85rem;">Waiting for first Google sign-in</td>
    <td style="padding:10px 8px;">
      <button type="button" class="btn btn-ghost btn-sm remove-invite-btn">Remove</button>
    </td>
  `;
  tr.querySelector(".remove-invite-btn").addEventListener("click", () => removeInvite(invite));
  els.usersTableBody.appendChild(tr);
}

async function removeInvite(invite) {
  const confirmed = await confirmDialog(`Remove the invite for ${invite.email}? They won't be pre-approved anymore — if they later sign in with Google, they'll land as "pending" like any unannounced account.`, { confirmLabel: "Remove" });
  if (!confirmed) return;
  const { error } = await supabase.from("invited_students").delete().eq("email", invite.email);
  if (error) {
    showToast(`Failed: ${error.message}`, "error");
    return;
  }
  showToast("Invite removed", "success");
  await loadData();
}

function renderUserRow(user) {
  const tr = document.createElement("tr");
  tr.style.borderBottom = "1px solid var(--color-border)";

  const statusBadgeColor = { active: "#1e9e5a", pending: "#c98a1e", disabled: "#c94141" }[user.status] || "#888";
  const testsLabel = user.allow_all_tests ? "All tests" : "Manage";
  const initial = (user.display_name || user.email || "?").charAt(0).toUpperCase();
  const access = computeAccess(user);
  const isSelected = selectedIds.has(user.id);

  tr.innerHTML = `
    <td style="padding:10px 8px;"><input type="checkbox" class="row-select-checkbox" ${isSelected ? "checked" : ""} aria-label="Select ${escapeHtml(user.email)}" /></td>
    <td style="padding:10px 8px;">${avatarCell(user.avatar_url, initial)}</td>
    <td style="padding:10px 8px;">
      <div>${escapeHtml(user.display_name || "—")}</div>
      <div style="color:var(--color-text-muted); font-size:0.82rem;">${escapeHtml(user.email)}</div>
    </td>
    <td style="padding:10px 8px;">
      <span style="color:${statusBadgeColor}; font-weight:600; text-transform:capitalize;">${user.status}</span>
    </td>
    <td style="padding:10px 8px;">
      <span class="access-badge ${access.badgeClass}">${access.label}</span>
      ${access.detail ? `<div style="font-size:0.78rem; color:var(--color-text-muted); margin-top:3px;">${escapeHtml(access.detail)}</div>` : ""}
    </td>
    <td style="padding:10px 8px;">
      <button type="button" class="link-btn manage-access-btn">${testsLabel}</button>
    </td>
    <td style="padding:10px 8px; color:var(--color-text-muted); font-size:0.85rem;">
      ${user.last_login_at ? formatDateTime(user.last_login_at) : "Never"}
    </td>
    <td style="padding:10px 8px; display:flex; gap:6px; flex-wrap:wrap;">
      ${user.status !== "active" ? `<button type="button" class="btn btn-secondary btn-sm activate-btn">Activate</button>` : ""}
      ${user.status !== "disabled" ? `<button type="button" class="btn btn-ghost btn-sm disable-btn">Disable</button>` : `<button type="button" class="btn btn-secondary btn-sm activate-btn">Re-enable</button>`}
      <button type="button" class="btn btn-ghost btn-sm extend-btn">Extend</button>
      <button type="button" class="btn btn-ghost btn-sm set-expiration-btn">Change Expiration</button>
      <button type="button" class="btn btn-ghost btn-sm revoke-btn">Revoke Sessions</button>
      <button type="button" class="btn btn-ghost btn-sm remove-access-btn">Remove Access</button>
    </td>
  `;

  tr.querySelector(".row-select-checkbox").addEventListener("change", (e) => {
    if (e.target.checked) selectedIds.add(user.id);
    else selectedIds.delete(user.id);
    render();
  });
  tr.querySelector(".manage-access-btn").addEventListener("click", () => openAccessDialog(user));
  tr.querySelector(".activate-btn")?.addEventListener("click", () => setStatus(user, "active"));
  tr.querySelector(".disable-btn")?.addEventListener("click", () => setStatus(user, "disabled"));
  tr.querySelector(".extend-btn").addEventListener("click", () => openExtendDialog([user.id]));
  tr.querySelector(".set-expiration-btn").addEventListener("click", () => openSetExpirationDialog([user.id]));
  tr.querySelector(".revoke-btn").addEventListener("click", () => revokeSessions(user));
  tr.querySelector(".remove-access-btn").addEventListener("click", () => removeAccess(user));

  els.usersTableBody.appendChild(tr);
}

/* =========================================================
   SINGLE-USER ACTIONS
   ========================================================= */
async function setStatus(user, status) {
  if (status === "disabled") {
    const confirmed = await confirmDialog(`Disable access for ${user.email}? They will no longer see any tests.`, { confirmLabel: "Disable" });
    if (!confirmed) return;
  }
  const { error } = await supabase.rpc("admin_set_status", { p_user_id: user.id, p_status: status });
  if (error) {
    showToast(`Failed: ${error.message}`, "error");
    return;
  }
  showToast(status === "active" ? "User activated" : "User disabled", "success");
  await loadData();
}

async function revokeSessions(user) {
  const confirmed = await confirmDialog(`Revoke all active sessions for ${user.email}? They'll be signed out everywhere immediately.`, { confirmLabel: "Revoke Sessions" });
  if (!confirmed) return;
  try {
    const { error } = await supabase.functions.invoke("admin-revoke-session", { body: { targetUserId: user.id, disable: false } });
    if (error) throw error;
    showToast("Sessions revoked", "success");
  } catch (err) {
    showToast(`Failed: ${err.message || err} (is the Edge Function deployed? see SETUP_SUPABASE_AUTH.md §7)`, "error");
  }
}

async function removeAccess(user) {
  const confirmed = await confirmDialog(`Remove access for ${user.email}? Their account and history stay in the system, but they'll immediately show as Expired and lose access to every test. This does not delete their account.`, { confirmLabel: "Remove Access" });
  if (!confirmed) return;
  const { error } = await supabase.rpc("admin_remove_access", { p_user_id: user.id });
  if (error) {
    showToast(`Failed: ${error.message}`, "error");
    return;
  }
  showToast("Access removed", "success");
  await loadData();
}

/* =========================================================
   EXTEND ACCESS (single row or bulk — same dialog, driven by
   extendTargetIds)
   ========================================================= */
function openExtendDialog(userIds) {
  extendTargetIds = userIds;
  els.extendDurationChoices.querySelectorAll(".duration-choice-btn").forEach((b) => b.classList.remove("selected"));
  els.extendDaysInput.value = "";
  els.confirmExtendBtn.disabled = true;
  els.extendAccessPreview.textContent = "";

  // Unlimited-conversion warning (spec §12) — only meaningful for a
  // single-student extend, since a bulk selection may mix unlimited and
  // finite accounts; showing one number's worth of "this will convert
  // unlimited access" for a mixed batch would be misleading, so the
  // bulk case just proceeds (each row's own extend math already treats
  // its own null expiration as "starting from now", which is the
  // correct behavior — the warning is a heads-up, not a safety gate).
  if (userIds.length === 1) {
    const user = allUsers.find((u) => u.id === userIds[0]);
    els.extendAccessTarget.textContent = `Student: ${user?.email || ""}`;
    const isUnlimited = !user?.access_expires_at;
    els.extendAccessCurrent.textContent = isUnlimited ? "Current expiration: No expiration set" : `Current expiration: ${formatDate(user.access_expires_at)}`;
    els.extendUnlimitedWarning.hidden = !isUnlimited;
  } else {
    els.extendAccessTarget.textContent = `Extend access for ${userIds.length} students`;
    els.extendAccessCurrent.textContent = "";
    els.extendUnlimitedWarning.hidden = true;
  }
  els.extendAccessDialog.showModal();
}

function updateExtendPreview() {
  const days = Number(els.extendDaysInput.value);
  const valid = Number.isInteger(days) && days > 0 && days <= 3650;
  els.confirmExtendBtn.disabled = !valid;
  if (!valid) {
    els.extendAccessPreview.textContent = "";
    return;
  }
  if (extendTargetIds.length === 1) {
    const user = allUsers.find((u) => u.id === extendTargetIds[0]);
    const base = user?.access_expires_at && new Date(user.access_expires_at) > new Date() ? new Date(user.access_expires_at) : new Date();
    const preview = new Date(base.getTime() + days * 86400000);
    els.extendAccessPreview.textContent = `New expiration: ${formatDate(preview)}`;
  } else {
    els.extendAccessPreview.textContent = `${extendTargetIds.length} students will be updated.`;
  }
}

async function confirmExtend() {
  const days = Number(els.extendDaysInput.value);
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    showToast("Please enter a valid number of days.", "error");
    return;
  }
  const isUnlimitedSingle = extendTargetIds.length === 1 && !els.extendUnlimitedWarning.hidden;
  if (isUnlimitedSingle) {
    const confirmed = await confirmDialog(
      `This student currently has unlimited access. Setting a duration will convert this account from unlimited access to time-limited access. Continue with ${days} day${days === 1 ? "" : "s"}?`,
      { confirmLabel: `Set ${days}-Day Access` }
    );
    if (!confirmed) return;
  }

  els.confirmExtendBtn.disabled = true;
  if (extendTargetIds.length > 1) {
    // Single round trip for the whole batch (spec §21/§22) — see
    // admin_extend_access_bulk() in 0009_days_based_access.sql.
    await runBulkRpc(() => supabase.rpc("admin_extend_access_bulk", { p_user_ids: extendTargetIds, p_days: days }), extendTargetIds.length, "extended");
  } else {
    await runBulkAction(extendTargetIds, (id) => supabase.rpc("admin_extend_access", { p_user_id: id, p_days: days, p_custom_expires_at: null }), "extended");
  }
  els.extendAccessDialog.close();
  els.confirmExtendBtn.disabled = false;
  await loadData();
}

/* =========================================================
   CHANGE / SET EXPIRATION (single row or bulk) — days-based,
   plus an explicit "Remove expiration" action (sets NULL).
   ========================================================= */
function openSetExpirationDialog(userIds) {
  setExpirationTargetIds = userIds;
  els.setExpirationQuickDays.querySelectorAll(".duration-choice-btn").forEach((b) => b.classList.remove("selected"));
  els.setExpirationDaysInput.value = "";
  if (userIds.length === 1) {
    const user = allUsers.find((u) => u.id === userIds[0]);
    els.setExpirationTitle.textContent = "Set Access Duration";
    els.setExpirationTarget.textContent = `Student: ${user?.email || ""}`;
  } else {
    els.setExpirationTitle.textContent = `Set expiration for ${userIds.length} students`;
    els.setExpirationTarget.textContent = "";
  }
  els.setExpirationDialog.showModal();
}

async function confirmSetExpiration() {
  const days = Number(els.setExpirationDaysInput.value);
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    showToast("Please enter a valid number of days.", "error");
    return;
  }
  const isBulk = setExpirationTargetIds.length > 1;
  if (isBulk) {
    const confirmed = await confirmDialog(`Set expiration for ${setExpirationTargetIds.length} students to ${days} day${days === 1 ? "" : "s"} from now?`, { confirmLabel: "Apply" });
    if (!confirmed) return;
  }
  els.confirmSetExpirationBtn.disabled = true;
  await runBulkAction(setExpirationTargetIds, (id) => supabase.rpc("admin_set_expiration", { p_user_id: id, p_expires_at: null, p_days: days }), "updated");
  els.setExpirationDialog.close();
  els.confirmSetExpirationBtn.disabled = false;
  await loadData();
}

async function confirmRemoveExpiration() {
  const ids = setExpirationTargetIds;
  const label = ids.length === 1 ? (allUsers.find((u) => u.id === ids[0])?.email || "this student") : `${ids.length} students`;
  const confirmed = await confirmDialog(`Remove the expiration for ${label}? Access will become unlimited.`, { confirmLabel: "Remove Expiration" });
  if (!confirmed) return;
  els.confirmSetExpirationBtn.disabled = true;
  await runBulkAction(ids, (id) => supabase.rpc("admin_set_expiration", { p_user_id: id, p_expires_at: null, p_days: null }), "set to unlimited");
  els.setExpirationDialog.close();
  els.confirmSetExpirationBtn.disabled = false;
  await loadData();
}

/* =========================================================
   BULK ENABLE / DISABLE / REVOKE / REMOVE
   ========================================================= */
async function bulkSetStatus(status) {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  const verb = status === "active" ? "Enable" : "Disable";
  const confirmed = await confirmDialog(`${verb} access for ${ids.length} selected student${ids.length === 1 ? "" : "s"}?`, { confirmLabel: `${verb} Student${ids.length === 1 ? "" : "s"}` });
  if (!confirmed) return;
  await runBulkAction(ids, (id) => supabase.rpc("admin_set_status", { p_user_id: id, p_status: status }), status === "active" ? "enabled" : "disabled");
  await loadData();
}

async function bulkRevokeSessions() {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  const confirmed = await confirmDialog(`Revoke all active sessions for ${ids.length} student${ids.length === 1 ? "" : "s"}? This will require them to sign in again.`, { confirmLabel: "Revoke Sessions" });
  if (!confirmed) return;
  await runBulkAction(ids, (id) => supabase.functions.invoke("admin-revoke-session", { body: { targetUserId: id, disable: false } }), "revoked");
}

async function bulkRemoveAccess() {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  const confirmed = await confirmDialog(`Remove access for ${ids.length} selected student${ids.length === 1 ? "" : "s"}? Their accounts and history stay in the system, but they'll immediately show as Expired.`, { confirmLabel: "Remove Access" });
  if (!confirmed) return;
  await runBulkAction(ids, (id) => supabase.rpc("admin_remove_access", { p_user_id: id }), "removed");
  await loadData();
}

/**
 * The one place every bulk action runs through — spec §26: report exact
 * partial failure ("18 selected, 16 updated, 2 failed"), never silently
 * report success, and disable the triggering control for the duration
 * (each caller above disables/re-enables its own button around this
 * call). Each per-id RPC call is independent, so one failure never
 * blocks or rolls back the others — this is "as atomic as practical"
 * for a set of otherwise-independent single-row RPCs, per that same
 * section's own wording, and it's what makes per-row failure reporting
 * possible at all (a single all-or-nothing transaction could only ever
 * report total success or total failure).
 */
async function runBulkAction(ids, actionFn, verbPast) {
  const results = await Promise.allSettled(ids.map((id) => actionFn(id)));
  const failed = [];
  results.forEach((r, i) => {
    const rpcError = r.status === "fulfilled" ? r.value?.error : r.reason;
    if (rpcError) failed.push({ id: ids[i], error: rpcError });
  });
  const succeeded = ids.length - failed.length;
  selectedIds.clear();
  if (failed.length === 0) {
    showToast(`${succeeded} student${succeeded === 1 ? "" : "s"} ${verbPast}.`, "success");
  } else {
    const failedEmails = failed.map(({ id }) => allUsers.find((u) => u.id === id)?.email || id).join(", ");
    showToast(`${ids.length} selected — ${succeeded} ${verbPast}, ${failed.length} failed (${failedEmails}).`, "error");
  }
  render();
}

/**
 * Companion to runBulkAction, for the genuine bulk RPCs (spec §21/§22 —
 * one round trip for the whole batch instead of N). The RPC itself
 * already did the looping server-side and returns one row per input id
 * with its own success/error_message — this just renders that result
 * the same way runBulkAction renders N separate settled promises, so
 * the two code paths look identical to the admin regardless of which
 * one ran underneath.
 */
async function runBulkRpc(rpcCall, totalCount, verbPast) {
  const { data, error } = await rpcCall();
  selectedIds.clear();
  if (error) {
    showToast(`Failed: ${error.message}`, "error");
    render();
    return;
  }
  const rows = data || [];
  const failed = rows.filter((r) => !r.success);
  const succeeded = totalCount - failed.length;
  if (failed.length === 0) {
    showToast(`${succeeded} student${succeeded === 1 ? "" : "s"} ${verbPast}.`, "success");
  } else {
    const failedEmails = failed.map((r) => r.email || r.user_id).join(", ");
    showToast(`${totalCount} selected — ${succeeded} ${verbPast}, ${failed.length} failed (${failedEmails}).`, "error");
  }
  render();
}

function updateBulkToolbar() {
  const count = selectedIds.size;
  els.bulkActionToolbar.hidden = count === 0;
  els.bulkSelectedCount.textContent = `${count} student${count === 1 ? "" : "s"} selected`;
}

/* =========================================================
   PER-TEST ACCESS DIALOG (unchanged from before this feature)
   ========================================================= */
function openAccessDialog(user) {
  accessDialogUser = user;
  els.accessDialogTitle.textContent = `Manage Access — ${user.email}`;
  els.allowAllToggle.classList.toggle("on", !!user.allow_all_tests);
  renderPerTestList();
  els.accessDialog.showModal();
}

async function renderPerTestList() {
  els.perTestList.innerHTML = "";
  if (accessDialogUser.allow_all_tests) {
    els.perTestList.innerHTML = `<p style="color:var(--color-text-muted); font-size:0.85rem;">"Allow All Tests" is on — individual grants below are ignored while it's on.</p>`;
  }

  const { data: grants } = await supabase.from("test_access").select("test_id").eq("user_id", accessDialogUser.id);
  const grantedIds = new Set((grants || []).map((g) => g.test_id));

  allTests.forEach((test) => {
    const row = document.createElement("label");
    row.style.cssText = "display:flex; align-items:center; gap:10px; font-size:0.9rem;";
    row.innerHTML = `
      <input type="checkbox" ${grantedIds.has(test.id) ? "checked" : ""} data-test-id="${test.id}" />
      <span>${escapeHtml(test.title)} ${test.status !== "published" ? `<em style="color:var(--color-text-muted);">(${test.status})</em>` : ""}</span>
    `;
    row.querySelector("input").addEventListener("change", async (e) => {
      if (e.target.checked) {
        const { error } = await supabase.from("test_access").insert({ user_id: accessDialogUser.id, test_id: test.id, created_by: currentAdmin.id });
        if (error) showToast(`Failed: ${error.message}`, "error");
      } else {
        const { error } = await supabase.from("test_access").delete().eq("user_id", accessDialogUser.id).eq("test_id", test.id);
        if (error) showToast(`Failed: ${error.message}`, "error");
      }
    });
    els.perTestList.appendChild(row);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

init();
