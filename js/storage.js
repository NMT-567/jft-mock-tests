/**
 * storage.js
 * Centralized localStorage access for exam session persistence (auto-save)
 * and completed-result persistence (used by result.html / review.html).
 *
 * All keys are namespaced under "nmt_" to avoid collisions with any other
 * app sharing the same origin on GitHub Pages.
 */

import { supabase } from "./supabaseClient.js?v=1";

const SESSION_KEY = "nmt_session_v1";
const RESULT_KEY = "nmt_last_result_v1";

/**
 * Session shape:
 * {
 *   testId, studentName, startedAt, durationSeconds, remainingSeconds,
 *   currentIndex, answers: { [questionId]: selectedOption },
 *   bookmarks: [questionId, ...], visited: [questionId, ...]
 * }
 */
export function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  } catch (err) {
    console.error("storage.saveSession failed", err);
    return false;
  }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("storage.loadSession failed", err);
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function hasActiveSession(testId) {
  const session = loadSession();
  if (!session) return false;
  if (testId && session.testId !== testId) return false;
  return true;
}

/** Persist the final computed result for the Result + Review pages to read. */
export function saveResult(result) {
  try {
    localStorage.setItem(RESULT_KEY, JSON.stringify(result));
    return true;
  } catch (err) {
    console.error("storage.saveResult failed", err);
    return false;
  }
}

export function loadResult() {
  try {
    const raw = localStorage.getItem(RESULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("storage.loadResult failed", err);
    return null;
  }
}

export function clearResult() {
  localStorage.removeItem(RESULT_KEY);
}

/**
 * --- Supabase-backed attempt tracking (added alongside the local
 * session/result buffers above, not replacing them) ---
 *
 * Local storage remains the source of truth for in-progress auto-save
 * (resume-after-refresh needs zero network latency) and is what
 * result.html/review.js actually render from — these functions exist so
 * a submitted attempt also lands in test_attempts for the dashboard's
 * "My Results" list and the admin's attempt visibility, per the spec's
 * §11/§12. If either call fails (offline, etc.) the local result still
 * saved above is not lost — see exam.js's submitTest(), which never lets
 * a Supabase failure block getting the student to their result page.
 */
/** Creates a new in_progress attempt row, or returns the id of an existing one for this user+test. */
/**
 * Returns `{ id, resumed }` — `resumed: true` means an existing
 * `in_progress` attempt was found and reused; `resumed: false` means a
 * brand-new attempt row was created (no open attempt existed, whether
 * because this is a first try or because the previous one was already
 * submitted). exam.js uses `resumed` to decide whether a local
 * leftover session is trustworthy — see its updated init(): a genuine
 * retry/retake always gets a fresh `resumed: false`, and any stale
 * local session for this test is discarded rather than silently
 * resumed, so re-opening the same link always starts at question 1
 * unless there's a real still-open attempt on the server to match.
 */
export async function startOrResumeAttempt(userId, testId, { isAdminPreview = false } = {}) {
  try {
    const { data: existing } = await supabase
      .from("test_attempts")
      .select("id")
      .eq("user_id", userId)
      .eq("test_id", testId)
      .eq("status", "in_progress")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return { id: existing.id, resumed: true };

    const { data, error } = await supabase
      .from("test_attempts")
      .insert({ user_id: userId, test_id: testId, is_admin_preview: isAdminPreview })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, resumed: false };
  } catch (err) {
    console.error("storage.startOrResumeAttempt failed (continuing without a remote attempt row)", err);
    return { id: null, resumed: false };
  }
}

/**
 * Submits an attempt via the submit-attempt Edge Function (Session 16),
 * NOT a direct table update — the client sends raw answers (question id
 * -> selected option), never a score. The server loads the test's real
 * content itself and recomputes everything, mirroring exam.js's own
 * scoring logic (see that Edge Function's header comment). A direct
 * client UPDATE of score/result is now blocked by a DB trigger
 * regardless (supabase/migrations/0002_protect_scoring.sql) — this
 * function existing is what makes submission still WORK despite that,
 * not just what makes it "more correct."
 *
 * Returns the server-computed result object (same shape saveResult()
 * writes locally) on success, or null on failure — callers should keep
 * showing the locally-computed result as a fallback either way (see
 * exam.js's submitTest(), which never blocks getting the student to
 * their result page on this call failing).
 */
export async function submitAttemptServerSide(attemptId, { answers, securityEvents, autoSubmitted, studentName }) {
  if (!attemptId) return null;
  try {
    // Explicitly attach the Authorization header rather than relying on
    // supabase-js's implicit auto-attach behavior for functions.invoke()
    // — confirmed via live testing that the implicit path was not
    // sending it (a real session existed, same client instance used
    // everywhere, yet the Edge Function received no Authorization
    // header at all: UNAUTHORIZED_NO_AUTH_HEADER). This makes the
    // header explicit and therefore certain, regardless of whatever
    // internal supabase-js/esm.sh behavior caused the implicit path to
    // fail. Session Auth Bearer is still the real user's own token —
    // this is not a service-role/elevated-privilege call.
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) throw new Error("No active session — cannot submit.");

    const { data, error } = await supabase.functions.invoke("submit-attempt", {
      body: { attemptId, answers, securityEvents, autoSubmitted, studentName },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data?.attempt?.result ?? null;
  } catch (err) {
    console.error("storage.submitAttemptServerSide failed (falling back to the local result)", err);
    return null;
  }
}
