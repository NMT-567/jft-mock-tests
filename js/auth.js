/**
 * auth.js
 * Real authentication for the student site, backed by Supabase Auth +
 * Google OAuth. Replaces the old shared-password gate (see the
 * project's continuation doc for that prior approach — it is fully
 * removed, not kept as a fallback, per the spec's "do not create a
 * separate username/password system").
 *
 * Every protected page calls requireAuth() as early as possible so an
 * unauthenticated visitor doesn't see real content — but unlike the old
 * sessionStorage check, this is a real async call to Supabase (OAuth
 * session validity can't be checked synchronously), so protected pages
 * should keep their content hidden behind a loading state until
 * requireAuth() resolves. See index.html/js/app.js for the pattern.
 *
 * IMPORTANT: nothing in this file is the actual authorization boundary.
 * Supabase Row Level Security (supabase/migrations/0001_init.sql) is
 * what actually stops an unauthorized or disabled user from reading
 * test content or writing attempts — this file only decides what the
 * UI shows. A user could disable all this JS and RLS still holds.
 */
import { supabase } from "./supabaseClient.js?v=1";

let cachedProfile = null; // public.users row for the current session, memoized per page load

/** Kick off the Google OAuth redirect flow. */
export async function signInWithGoogle(redirectPath = "index.html") {
  const redirectTo = new URL(redirectPath, window.location.href).toString();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
  cachedProfile = null;
}

/** The raw Supabase auth session, or null if signed out / expired. */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session;
}

/**
 * The corresponding public.users row (status, allow_all_tests, etc.).
 * Returns null if there's no session. The on_auth_user_created trigger
 * guarantees a row exists after any successful Google sign-in.
 */
export async function getProfile({ forceRefresh = false } = {}) {
  if (cachedProfile && !forceRefresh) return cachedProfile;
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await supabase.from("users").select("*").eq("id", session.user.id).single();
  if (error) {
    console.error("auth.getProfile failed", error);
    return null;
  }
  cachedProfile = data;
  return data;
}

export async function isAdmin() {
  const profile = await getProfile();
  if (!profile) return false;
  const { data, error } = await supabase.from("admins").select("user_id").eq("user_id", profile.id).maybeSingle();
  if (error) return false;
  return !!data;
}

/**
 * Call at the top of every protected page. Redirects to login.html
 * (preserving where the visitor was headed) if there's no session, or
 * to access-denied.html if the session is valid but the account is
 * pending/disabled. Returns the profile on success so callers don't
 * need a second round-trip.
 */
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    redirectToLogin();
    return null;
  }
  const profile = await getProfile();
  if (!profile || profile.status !== "active") {
    window.location.href = "access-denied.html";
    return null;
  }
  return profile;
}

function redirectToLogin() {
  const redirect = encodeURIComponent(window.location.pathname.split("/").pop());
  window.location.href = `login.html?redirect=${redirect}`;
}
