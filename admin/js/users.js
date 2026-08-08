/**
 * users.js
 * Controller for admin/users.html — the allowlist + per-test access
 * management screen (spec §2, §14, §15). Everything here reads/writes
 * through the normal supabase-js client using the signed-in admin's own
 * session; RLS (public.users_admin_all, test_access_admin_*, etc. in
 * supabase/migrations/0001_init.sql) is what actually authorizes these
 * writes — this file has no elevated privileges of its own. The one
 * exception is session revocation, which calls the admin-revoke-session
 * Edge Function (the only place the service-role key is used).
 */
import { requireAdminSession } from "./adminAuth.js?v=1";
import { supabase } from "../../js/supabaseClient.js?v=1";
import { hidePageLoader, initThemeToggle, stampYear } from "../../js/utils.js?v=4";
import { showToast, confirmDialog } from "./components.js?v=3";

const els = {
  mainContent: document.getElementById("mainContent"),
  darkModeToggle: document.getElementById("darkModeToggle"),
  addStudentEmailInput: document.getElementById("addStudentEmailInput"),
  addStudentBtn: document.getElementById("addStudentBtn"),
  addStudentMessage: document.getElementById("addStudentMessage"),
  userSearchInput: document.getElementById("userSearchInput"),
  userCount: document.getElementById("userCount"),
  usersTableBody: document.getElementById("usersTableBody"),
  usersEmptyState: document.getElementById("usersEmptyState"),
  accessDialog: document.getElementById("accessDialog"),
  accessDialogTitle: document.getElementById("accessDialogTitle"),
  allowAllToggle: document.getElementById("allowAllToggle"),
  perTestList: document.getElementById("perTestList"),
  closeAccessDialogBtn: document.getElementById("closeAccessDialogBtn"),
};

let allUsers = [];
let allInvites = []; // public.invited_students rows with no matching public.users row yet — see loadData()
let allTests = [];
let accessDialogUser = null;
let currentAdmin = null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    // Only show an invite as its own "waiting for first sign-in" row
    // when nobody has actually signed in with that email yet — once
    // they do, the real public.users row (auto-activated, per
    // handle_new_auth_user()'s invited_students check) takes over and
    // this entry becomes redundant.
    const realEmails = new Set(allUsers.map((u) => u.email.toLowerCase()));
    allInvites = (invites || []).filter((inv) => !realEmails.has(inv.email.toLowerCase()));
  }
  allTests = (tests || []).filter((t) => t.status !== "archived");
  if (testsErr) console.error(testsErr);
  render();
}

function bindEvents() {
  els.addStudentBtn.addEventListener("click", handleAddStudent);
  els.addStudentEmailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAddStudent();
  });
  els.userSearchInput.addEventListener("input", render);
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
}

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
  const alreadyReal = allUsers.some((u) => u.email.toLowerCase() === email);
  const alreadyInvited = allInvites.some((inv) => inv.email.toLowerCase() === email);
  if (alreadyReal || alreadyInvited) {
    setAddStudentMessage("That email has already been added.", "error");
    return;
  }

  els.addStudentBtn.disabled = true;
  try {
    const { error } = await supabase.from("invited_students").insert({ email, created_by: currentAdmin.id });
    if (error) throw error;
    setAddStudentMessage("Student email added successfully. They can now sign in with Google.", "success");
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

function render() {
  const term = els.userSearchInput.value.trim().toLowerCase();
  const filteredUsers = allUsers.filter(
    (u) => !term || u.email.toLowerCase().includes(term) || (u.display_name || "").toLowerCase().includes(term)
  );
  const filteredInvites = allInvites.filter((inv) => !term || inv.email.toLowerCase().includes(term));

  const totalCount = filteredUsers.length + filteredInvites.length;
  els.userCount.textContent = `${totalCount} user${totalCount === 1 ? "" : "s"}`;
  els.usersEmptyState.hidden = allUsers.length + allInvites.length > 0;
  els.usersTableBody.innerHTML = "";

  filteredInvites.forEach((invite) => renderInviteRow(invite));
  filteredUsers.forEach((user) => renderUserRow(user));
}

function avatarCell(avatarUrl, placeholderInitial) {
  if (avatarUrl) {
    return `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:32px; height:32px; border-radius:50%; object-fit:cover; display:block;" />`;
  }
  return `<div style="width:32px; height:32px; border-radius:50%; background:var(--color-border); display:flex; align-items:center; justify-content:center; font-size:0.8rem; color:var(--color-text-muted);">${escapeHtml(placeholderInitial || "?")}</div>`;
}

/** An email the admin added that has never actually signed in yet — no public.users row exists for it (see loadData()'s filter). Shown as its own lightweight row so the admin can see "yes, I added this" without it looking like a full account. */
function renderInviteRow(invite) {
  const tr = document.createElement("tr");
  tr.style.borderBottom = "1px solid var(--color-border)";
  tr.innerHTML = `
    <td style="padding:10px 8px;">${avatarCell(null, "?")}</td>
    <td style="padding:10px 8px;">
      <div style="color:var(--color-text-muted); font-style:italic;">Not signed in yet</div>
      <div style="color:var(--color-text-muted); font-size:0.82rem;">${escapeHtml(invite.email)}</div>
    </td>
    <td style="padding:10px 8px;">
      <span style="color:#888; font-weight:600;">Invited</span>
    </td>
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

    tr.innerHTML = `
      <td style="padding:10px 8px;">${avatarCell(user.avatar_url, initial)}</td>
      <td style="padding:10px 8px;">
        <div>${escapeHtml(user.display_name || "—")}</div>
        <div style="color:var(--color-text-muted); font-size:0.82rem;">${escapeHtml(user.email)}</div>
      </td>
      <td style="padding:10px 8px;">
        <span style="color:${statusBadgeColor}; font-weight:600; text-transform:capitalize;">${user.status}</span>
      </td>
      <td style="padding:10px 8px;">
        <button type="button" class="link-btn manage-access-btn">${testsLabel}</button>
      </td>
      <td style="padding:10px 8px; color:var(--color-text-muted); font-size:0.85rem;">
        ${user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "Never"}
      </td>
      <td style="padding:10px 8px; display:flex; gap:6px; flex-wrap:wrap;">
        ${user.status !== "active" ? `<button type="button" class="btn btn-secondary btn-sm activate-btn">Activate</button>` : ""}
        ${user.status !== "disabled" ? `<button type="button" class="btn btn-ghost btn-sm disable-btn">Disable</button>` : `<button type="button" class="btn btn-secondary btn-sm activate-btn">Re-enable</button>`}
        <button type="button" class="btn btn-ghost btn-sm revoke-btn">Revoke Sessions</button>
      </td>
    `;

    tr.querySelector(".manage-access-btn").addEventListener("click", () => openAccessDialog(user));
    tr.querySelector(".activate-btn")?.addEventListener("click", () => setStatus(user, "active"));
    tr.querySelector(".disable-btn")?.addEventListener("click", () => setStatus(user, "disabled"));
    tr.querySelector(".revoke-btn").addEventListener("click", () => revokeSessions(user));

    els.usersTableBody.appendChild(tr);
}

async function setStatus(user, status) {
  if (status === "disabled") {
    const confirmed = await confirmDialog(`Disable access for ${user.email}? They will no longer see any tests.`, { confirmLabel: "Disable" });
    if (!confirmed) return;
  }
  const { error } = await supabase.from("users").update({ status }).eq("id", user.id);
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
    const { error } = await supabase.functions.invoke("admin-revoke-session", {
      body: { targetUserId: user.id, disable: false },
    });
    if (error) throw error;
    showToast("Sessions revoked", "success");
  } catch (err) {
    showToast(`Failed: ${err.message || err} (is the Edge Function deployed? see SETUP_SUPABASE_AUTH.md §7)`, "error");
  }
}

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
