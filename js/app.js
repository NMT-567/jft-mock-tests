/**
 * app.js
 * Controller for index.html — the post-login dashboard (spec §4). Lists
 * only tests the signed-in user is actually authorized for (RLS on
 * public.tests already filters this — the query below is not itself an
 * authorization check, just a read of whatever RLS lets through) plus
 * their own result history (spec §12).
 */
import { requireAuth, signOut } from "./auth.js?v=4";
import { supabase } from "./supabaseClient.js?v=1";
import { hasActiveSession, loadSession, clearSession } from "./storage.js?v=7";
import { hidePageLoader, initThemeToggle, stampYear, escapeHtml } from "./utils.js?v=5";

const els = {
  welcomeHeading: document.getElementById("welcomeHeading"),
  userDisplayName: document.getElementById("userDisplayName"),
  signOutBtn: document.getElementById("signOutBtn"),
  darkModeToggle: document.getElementById("darkModeToggle"),
  testsList: document.getElementById("testsList"),
  testsEmptyState: document.getElementById("testsEmptyState"),
  resultsList: document.getElementById("resultsList"),
  resultsEmptyState: document.getElementById("resultsEmptyState"),
};

async function init() {
  stampYear();
  initThemeToggle(els.darkModeToggle);
  els.signOutBtn.addEventListener("click", handleSignOut);

  const profile = await requireAuth();
  if (!profile) return; // requireAuth() already redirected to login or access-denied

  els.welcomeHeading.textContent = `Welcome, ${profile.display_name || profile.email}`;
  els.userDisplayName.textContent = profile.email;

  try {
    const [{ data: tests, error: testsErr }, { data: attempts, error: attemptsErr }] = await Promise.all([
      supabase.from("tests").select("id, title, category_name, total_questions, total_points").eq("status", "published"),
      supabase
        .from("test_attempts")
        .select("id, test_id, status, submitted_at, score, result")
        .eq("user_id", profile.id)
        .eq("is_admin_preview", false)
        .order("submitted_at", { ascending: false, nullsFirst: false }),
    ]);
    if (testsErr) throw testsErr;
    renderTests(tests || [], attempts || []);
    renderResults((attempts || []).filter((a) => a.status === "submitted"));
  } catch (err) {
    console.error("Dashboard load failed", err);
    els.testsList.innerHTML = `<p style="color: var(--color-text-muted);">Could not load your tests. Please refresh and try again.</p>`;
  } finally {
    hidePageLoader();
  }
}

function renderTests(tests, attempts) {
  els.testsList.querySelectorAll(".dashboard-test-card").forEach((n) => n.remove());
  els.testsEmptyState.hidden = tests.length > 0;

  tests.forEach((test) => {
    const attemptsForTest = attempts.filter((a) => a.test_id === test.id);
    const inProgress = attemptsForTest.find((a) => a.status === "in_progress");
    const submitted = attemptsForTest.find((a) => a.status === "submitted");
    const hasLocalResume = hasActiveSession(test.id);

    const card = document.createElement("div");
    card.className = "card dashboard-test-card";
    card.style.cssText = "padding:20px; display:flex; flex-direction:column; gap:10px;";

    const meta = [
      test.total_questions ? `${test.total_questions} Questions` : null,
      test.total_points ? `${test.total_points} Points` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    let actionLabel = "Start Test";
    if (submitted) actionLabel = "Retake Test";
    else if (inProgress || hasLocalResume) actionLabel = "Resume Test";

    card.innerHTML = `
      <span class="badge badge-category">${escapeHtml(test.category_name || "General")}</span>
      <h3 style="margin:0;">${escapeHtml(test.title)}</h3>
      <p style="margin:0; color: var(--color-text-muted); font-size:0.9rem;">${escapeHtml(meta || "—")}</p>
      <div style="display:flex; gap:10px; margin-top:8px;">
        <button type="button" class="btn btn-primary start-btn">${actionLabel}</button>
        ${submitted ? `<button type="button" class="btn btn-secondary view-result-btn">View Last Result</button>` : ""}
      </div>
    `;

    card.querySelector(".start-btn").addEventListener("click", () => {
      if (!(inProgress || hasLocalResume) && submitted) clearSession(); // starting a fresh retake
      window.location.href = `exam.html?testId=${encodeURIComponent(test.id)}`;
    });
    card.querySelector(".view-result-btn")?.addEventListener("click", () => {
      window.location.href = `result.html?attemptId=${encodeURIComponent(submitted.id)}`;
    });

    els.testsList.appendChild(card);
  });
}

function renderResults(submittedAttempts) {
  els.resultsList.querySelectorAll(".result-row").forEach((n) => n.remove());
  els.resultsEmptyState.hidden = submittedAttempts.length > 0;

  submittedAttempts.forEach((attempt) => {
    const r = attempt.result || {};
    const row = document.createElement("div");
    row.className = "card result-row";
    row.style.cssText = "padding:14px 18px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;";
    const submittedDate = attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleDateString() : "—";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(r.testTitle || "Mock Test")}</strong>
        <div style="color: var(--color-text-muted); font-size:0.85rem;">
          Score: ${r.marksScored ?? "—"} / ${r.totalMarks ?? "—"} · Completed ${submittedDate}
        </div>
      </div>
      <button type="button" class="btn btn-secondary view-btn">View Result</button>
    `;
    row.querySelector(".view-btn").addEventListener("click", () => {
      window.location.href = `result.html?attemptId=${encodeURIComponent(attempt.id)}`;
    });
    els.resultsList.appendChild(row);
  });
}

async function handleSignOut() {
  await signOut();
  window.location.href = "login.html";
}

init();
