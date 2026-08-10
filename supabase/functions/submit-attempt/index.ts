// supabase/functions/submit-attempt/index.ts
//
// THE authoritative scoring path (Session 16). Before this existed,
// js/storage.js's submitAttempt() did a direct client-side UPDATE of
// test_attempts.score/result — RLS only checked *ownership* of the row,
// not *who computed the score*, so a student could open devtools and
// write any score they wanted to their own row. This function is what
// actually closes that: the client now sends raw answers (question id
// -> selected option), never a score, and this function — running
// server-side — loads the test's real content itself and recomputes
// everything, mirroring js/exam.js's submitTest()/convertRawScore()
// logic exactly (see that file's comments — this is intentionally kept
// in lockstep with it; there's no practical way to share one module
// between browser ESM and a Deno Edge Function without a build step,
// which this project deliberately doesn't have, so if you ever change
// the scoring formula in exam.js, mirror the change here too).
//
// What this does NOT fix: the exported test content (tests.content)
// still includes each question's correctOption, because the exam UI
// needs it client-side for the existing instant local "Review Answers"
// screen. A sufficiently determined user can still read tests.content
// via the browser's network tab or devtools console before answering
// and know every correct answer in advance. This function only closes
// the *specific* hole of forging an attempt's stored score/result after
// the fact — it does not, and structurally cannot, prevent someone from
// looking up answers ahead of time while the answer key is shipped to
// the client at all. That's a pre-existing, disclosed limitation of this
// project's fully client-rendered exam engine (see Session 14 notes on
// "server-side score validation is impossible... the entire answer key
// is already shipped to the client by design") — unchanged by this fix.
//
// Deploy:
//   supabase functions deploy submit-attempt
// Uses only the auto-injected SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY env vars — no extra secrets to configure.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS — the actual root cause of the live "Couldn't submit" failure:
// the browser sends a CORS preflight (OPTIONS) before the real POST,
// because the request carries an Authorization header + JSON content
// type cross-origin (the site is served from github.io, this function
// from supabase.co). Without a response to that preflight containing
// Access-Control-Allow-Origin, the browser blocks the real request
// entirely — the function's own logic never even runs; this is a
// client-side browser security check, not anything server-side to
// debug. `*` here is safe: this endpoint's real protection is the JWT
// verification below (auth.getUser() + ownership checks), not CORS —
// CORS only controls which *websites* can read a response via
// JavaScript, it is not an authorization mechanism.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Scoped to the CALLER's own token — used only to establish who is
    // calling. All the actual reads/writes below use the service-role
    // client instead, because this function IS the trusted path that's
    // allowed to set score/result/status (the DB trigger
    // protect_attempt_scoring() blocks everyone else from setting those
    // columns directly — see supabase/migrations/0002_protect_scoring.sql).
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerData?.user) return json({ error: "Invalid session" }, 401);
    const callerId = callerData.user.id;

    const body = await req.json();
    const { attemptId, answers, securityEvents, autoSubmitted, studentName } = body;
    if (!attemptId || typeof answers !== "object") {
      return json({ error: "attemptId and answers are required" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: attempt, error: attemptErr } = await admin
      .from("test_attempts")
      .select("id, user_id, test_id, status, is_admin_preview")
      .eq("id", attemptId)
      .single();
    if (attemptErr || !attempt) return json({ error: "Attempt not found" }, 404);
    if (attempt.user_id !== callerId) return json({ error: "This attempt does not belong to you" }, 403);
    if (attempt.status !== "in_progress") return json({ error: "This attempt was already submitted" }, 409);

    // Re-check access RIGHT NOW, server-side, even though this attempt
    // was legitimately created earlier while access was valid — this is
    // exactly the "already-open tab" case the access-expiration spec
    // calls out: a browser tab that loaded the exam before expiration/
    // disable has no reason to make another authorization-checked
    // request before hitting Submit, so without this the only other
    // access check (get_exam_content, at load time) could be stale by
    // the time this fires. Skipped for admin-preview rows, same as
    // every other access check in this project — an admin previewing
    // their own draft was never subject to has_test_access() anyway.
    if (!attempt.is_admin_preview) {
      const { data: stillAuthorized } = await admin.rpc("has_test_access", { uid: callerId, tid: attempt.test_id });
      if (!stillAuthorized) {
        return json({ error: "Your access has expired or been disabled — this attempt could not be submitted. Please contact your administrator." }, 403);
      }
    }

    const { data: test, error: testErr } = await admin
      .from("tests")
      .select("id, title, category_name, content")
      .eq("id", attempt.test_id)
      .single();
    if (testErr || !test) return json({ error: "Test not found" }, 404);

    const result = computeResult(test.content, answers, {
      studentName: studentName || "Student",
      autoSubmitted: !!autoSubmitted,
      securityEvents: Array.isArray(securityEvents) ? securityEvents : [],
    });

    const { data: updated, error: updateErr } = await admin
      .from("test_attempts")
      .update({
        status: "submitted",
        submitted_at: result.submittedAt,
        score: result.finalScore,
        max_score: result.resultSettings.maxScore,
        result,
      })
      .eq("id", attemptId)
      .select()
      .single();
    if (updateErr) return json({ error: `Failed to store result: ${updateErr.message}` }, 500);

    return json({ ok: true, attempt: updated });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

// ---------------------------------------------------------------------
// Scoring logic — mirrors js/exam.js's submitTest()/convertRawScore().
// See this file's header comment for why it's duplicated rather than
// shared.
// ---------------------------------------------------------------------

const DEFAULT_RESULT_SETTINGS = {
  titleJa: "試験の結果をお知らせします。",
  titleEn: "Your test results are as follows.",
  minScore: 10,
  maxScore: 250,
  passingScore: 200,
  scoreMode: "raw",
  rawMin: 0,
  rawMax: null,
  finalMin: 10,
  finalMax: 250,
  passedJa: "あなたは日本語能力水準に達しました。",
  passedEn: "You were assessed to have reached the required Japanese language proficiency level.",
  failedJa: "あなたは日本語能力水準には達していないと判定されました。",
  failedEn: "You were assessed to have not reached the required Japanese language proficiency level.",
  sectionLabels: {},
};

function convertRawScore(raw: number, totalMarks: number, rs: any): number {
  let value: number;
  if (rs.scoreMode === "percentage") {
    const pct = totalMarks > 0 ? raw / totalMarks : 0;
    value = rs.minScore + pct * (rs.maxScore - rs.minScore);
  } else if (rs.scoreMode === "scaled") {
    const rawMin = typeof rs.rawMin === "number" ? rs.rawMin : 0;
    const rawMax = typeof rs.rawMax === "number" && rs.rawMax !== null ? rs.rawMax : totalMarks;
    const span = rawMax - rawMin;
    const t = span > 0 ? Math.min(1, Math.max(0, (raw - rawMin) / span)) : 0;
    value = rs.finalMin + t * (rs.finalMax - rs.finalMin);
  } else {
    value = raw;
  }
  return Math.round(Math.min(rs.maxScore, Math.max(rs.minScore, value)));
}

function computeResult(
  content: any,
  answers: Record<string, number>,
  meta: { studentName: string; autoSubmitted: boolean; securityEvents: unknown[] }
) {
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  let marksScored = 0;
  let totalQuestions = 0;
  let totalMarks = 0;

  const sectionAgg = new Map<string, any>();
  const detailedAnswers: any[] = [];

  for (const section of content.sections || []) {
    for (const group of section.groups || []) {
      for (const q of group.questions || []) {
        totalQuestions += 1;
        totalMarks += q.marks || 0;

        if (!sectionAgg.has(section.title)) {
          sectionAgg.set(section.title, { sectionId: section.id, totalQuestions: 0, correct: 0, wrong: 0, earnedPoints: 0, availablePoints: 0 });
        }
        const agg = sectionAgg.get(section.title);
        agg.totalQuestions += 1;
        agg.availablePoints += q.marks || 0;

        const given = answers[q.id];
        const isAnswered = given !== undefined && given !== null;
        const isCorrect = isAnswered && given === q.correctOption;

        if (!isAnswered) skipped += 1;
        else if (isCorrect) {
          correct += 1;
          marksScored += q.marks || 0;
          agg.correct += 1;
          agg.earnedPoints += q.marks || 0;
        } else {
          wrong += 1;
          agg.wrong += 1;
        }

        detailedAnswers.push({
          questionId: q.id,
          question: q.question,
          passage: group.type === "passage_group" ? group.passageText : null,
          options: q.options,
          correctOption: q.correctOption,
          givenOption: given ?? null,
          isCorrect,
          explanation: q.explanation,
          marks: q.marks,
          // Previously only ever read the GROUP's own shared image/audio
          // here — but this project's real content almost always stores
          // media on each QUESTION instead (see admin/js/export.js and
          // js/loader.js, which carry q.imageUrl/q.audioUrl through for
          // exactly this reason). Same "single" vs. everything-else
          // convention used by js/groupRenderer.js's buildQuestionBlock,
          // so review shows precisely what the exam itself showed. Falls
          // back to the group's own field if the question has none of
          // its own, so a hand-authored group with real shared media
          // still works too.
          imageUrl: (group.type === "single" ? group.imageUrl : (q.imageUrl || group.imageUrl)) ?? null,
          audioUrl: (group.type === "single" ? group.audioUrl : (q.audioUrl || group.audioUrl)) ?? null,
          sectionTitle: section.title,
          groupType: group.type,
        });
      }
    }
  }

  const percentage = totalMarks > 0 ? Math.round((marksScored / totalMarks) * 1000) / 10 : 0;
  const rs = { ...DEFAULT_RESULT_SETTINGS, ...(content.resultSettings || {}) };
  const finalScore = convertRawScore(marksScored, totalMarks, rs);
  const passed = finalScore >= rs.passingScore;
  const sections = [...sectionAgg.values()].map((s) => ({
    ...s,
    percentage: s.availablePoints > 0 ? Math.round((s.earnedPoints / s.availablePoints) * 100) : 0,
  }));

  return {
    testId: content.id,
    testTitle: content.title,
    category: content.categoryName,
    studentName: meta.studentName,
    submittedAt: new Date().toISOString(),
    autoSubmitted: meta.autoSubmitted,
    totalQuestions,
    correct,
    wrong,
    skipped,
    marksScored,
    totalMarks,
    percentage,
    passMarks: content.passMarks,
    passed,
    answers: detailedAnswers,
    sections,
    finalScore,
    resultSettings: rs,
    securityEvents: meta.securityEvents,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
