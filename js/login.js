/**
 * login.js
 * Controller for login.html. If a valid session already exists (a
 * returning authorized user), skips straight to the dashboard — this is
 * the "remember login" requirement (§6): no re-login on every visit.
 * Otherwise wires the "Continue with Google" button to the OAuth
 * redirect flow. After Google redirects back here (or wherever
 * ?redirect= points), index.html's own requireAuth() call is what
 * actually checks allowlist status and routes to access-denied.html if
 * needed — this page only starts the OAuth handshake.
 */
import { getSession, signInWithGoogle } from "./auth.js?v=4";
import { hidePageLoader, initThemeToggle, getQueryParam } from "./utils.js?v=4";

const els = {
  darkModeToggle: document.getElementById("darkModeToggle"),
  googleSignInBtn: document.getElementById("googleSignInBtn"),
  loginError: document.getElementById("loginError"),
};

async function init() {
  initThemeToggle(els.darkModeToggle);
  els.googleSignInBtn.addEventListener("click", handleGoogleSignIn);

  // Returning user with a still-valid Supabase session — skip login.
  const session = await getSession();
  if (session) {
    window.location.href = getQueryParam("redirect") || "index.html";
    return;
  }
  hidePageLoader();
}

async function handleGoogleSignIn() {
  els.loginError.hidden = true;
  els.googleSignInBtn.disabled = true;
  try {
    const redirect = getQueryParam("redirect") || "index.html";
    await signInWithGoogle(redirect);
    // signInWithGoogle triggers a full-page redirect to Google; nothing
    // after this line runs unless it threw before redirecting.
  } catch (err) {
    console.error("Google sign-in failed", err);
    els.loginError.textContent = "Couldn't start Google sign-in. Please try again.";
    els.loginError.hidden = false;
    els.googleSignInBtn.disabled = false;
  }
}

init();
