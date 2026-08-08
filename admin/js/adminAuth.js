/**
 * adminAuth.js
 * The admin panel's local-editor pages (editor.html, bank.html, etc.)
 * intentionally have NO login — see admin/README.md, that's unchanged.
 * But any admin page that talks to Supabase (publishing a test, managing
 * users) needs the operator to be signed in with a Google account that's
 * actually in public.admins, because that's what Supabase RLS checks
 * (supabase/migrations/0001_init.sql's `is_admin()`). This module is
 * that gate, reusing the exact same Supabase Auth session the student
 * site uses — an admin signs in with the same "Continue with Google"
 * flow at ../login.html, just needs their account to also be in
 * public.admins (see SETUP_SUPABASE_AUTH.md §6).
 */
import { getSession, getProfile, isAdmin, signInWithGoogle, signOut } from "../../js/auth.js?v=4";

/**
 * Call at the top of any admin page that needs Supabase writes. Returns
 * the admin's profile on success. On failure, replaces the page body
 * with a sign-in prompt (not a redirect loop back into the local-only
 * admin panel, which has no login page of its own) and returns null.
 */
export async function requireAdminSession(mountEl) {
  const session = await getSession();
  if (!session) {
    renderSignInPrompt(mountEl, "Sign in with the Google account that has admin access to manage this.");
    return null;
  }
  const profile = await getProfile();
  const admin = await isAdmin();
  if (!profile || !admin) {
    renderSignInPrompt(
      mountEl,
      `Signed in as ${profile?.email || "unknown"}, but this account isn't an admin. Sign in with your admin Google account, or ask an existing admin to add you (see SETUP_SUPABASE_AUTH.md §6).`,
      true
    );
    return null;
  }
  return profile;
}

function renderSignInPrompt(mountEl, message, showSignOut = false) {
  if (!mountEl) return;
  mountEl.innerHTML = `
    <div class="card" style="max-width:480px; margin:60px auto; padding:28px; text-align:center;">
      <h2 style="margin-top:0;">Admin sign-in required</h2>
      <p style="color: var(--color-text-muted); margin-bottom:20px;">${message}</p>
      <div style="display:flex; gap:10px; justify-content:center;">
        <button type="button" class="btn btn-primary" id="adminGoogleSignInBtn">Continue with Google</button>
        ${showSignOut ? `<button type="button" class="btn btn-ghost" id="adminSignOutBtn">Sign out</button>` : ""}
      </div>
    </div>
  `;
  document.getElementById("adminGoogleSignInBtn").addEventListener("click", () => {
    signInWithGoogle(window.location.pathname + window.location.search);
  });
  document.getElementById("adminSignOutBtn")?.addEventListener("click", async () => {
    await signOut();
    window.location.reload();
  });
}
