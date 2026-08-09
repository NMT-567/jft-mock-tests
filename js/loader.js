/**
 * loader.js
 * Fetches /data/Selected_Mock_Tests.json (v2 schema) and normalizes it into
 * the shape exam.js needs: an ordered list of "pages" (one per group, each
 * carrying its section context) plus a flat, globally-numbered question
 * index used for the palette, scoring, and jump-to-question.
 *
 * v2 schema (see admin/README.md for the authoritative contract):
 * {
 *   formatVersion: 2, source, exportedAt,
 *   id, title, categoryName, topic, description, language,
 *   duration, noTimeLimit, passMarks, active, premium, createdAt, updatedAt,
 *   sections: [{
 *     id, title,
 *     groups: [{
 *       id, type: "single"|"passage_group"|"conversation_group"|"listening_group"|"image_group",
 *       title, passageText, speakerAName, speakerAText, speakerBName, speakerBText,
 *       imageUrl, audioUrl,
 *       questions: [{ id, question, options, correctOption, explanation, marks }]
 *     }]
 *   }]
 * }
 */

/** Same-origin localStorage key the admin editor writes an in-memory export document to right before opening exam.html?adminPreview=1 — lets "Test as User" run the real exam UI/scoring/result flow against the CURRENT unsaved draft, without ever touching Supabase. */
const ADMIN_PREVIEW_KEY = "nmt_admin_preview_test_v1";

let cachedTest = null;
let cachedTestId = null;

function isAdminPreviewRequested() {
  return new URLSearchParams(window.location.search).get("adminPreview") === "1";
}

/**
 * Fetches a test's content for the exam UI via the get_exam_content()
 * Postgres function (supabase/migrations/0003_hide_answer_key.sql) —
 * NOT a direct `.select("content")` anymore. That RPC is the only path
 * to `tests.content` from application code: it re-checks authorization
 * itself (is_admin() OR published+has_test_access — the same logic the
 * old RLS policy had) and, for anyone who isn't an admin, strips
 * `correctOption`/`explanation` from every question before returning.
 * Direct table-level SELECT on `content` is revoked for every role at
 * the database level (see that migration) — this isn't just "the UI
 * doesn't ask for it," a raw `supabase.from('tests').select('content')`
 * call from devtools now genuinely fails for a non-admin.
 *
 * Admins (editor's "Publish"/"Preview", admin/tests.html's "Preview" /
 * "Preview as User") still receive the FULL content including
 * correctOption — the RPC itself branches on is_admin(), not this file.
 */
async function fetchExport(testId) {
  if (isAdminPreviewRequested()) {
    const raw = localStorage.getItem(ADMIN_PREVIEW_KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error("Admin preview data was corrupted — go back to the editor and click Test as User again.");
      }
    }
    throw new Error("No admin preview data found — go back to the editor and click Test as User again.");
  }
  if (!testId) {
    throw new Error("No testId provided — open this page from the dashboard, not directly.");
  }
  const { supabase } = await import("./supabaseClient.js?v=1");
  const { data, error } = await supabase.rpc("get_exam_content", { p_test_id: testId });
  if (error || !data) {
    throw new Error("This test is unavailable, or you're not authorized to access it.");
  }
  return data;
}

function normalizeQuestion(raw, globalIndex) {
  return {
    id: raw.id || `q-${globalIndex}`,
    order: globalIndex + 1,
    text: raw.question || "",
    options: Array.isArray(raw.options) ? raw.options : [],
    correctOption: raw.correctOption ?? null,
    explanation: raw.explanation || "",
    marks: typeof raw.marks === "number" ? raw.marks : 1,
    required: !!raw.required,
    // Previously omitted here — silently dropped every question's own
    // image/audio before it ever reached groupRenderer.js, even though
    // that renderer correctly checks for it (q.imageUrl/q.audioUrl for
    // non-"single" groups). The data never made it this far to begin
    // with. See the matching fix in admin/js/export.js's
    // buildExportQuestion(), which is what actually publishes these
    // two fields into the data this function reads.
    imageUrl: raw.imageUrl || null,
    audioUrl: raw.audioUrl || null,
  };
}

function normalizeGroup(raw, sectionIndex, sectionTitle, pageIndex) {
  return {
    id: raw.id || `grp-${pageIndex}`,
    type: raw.type || "single",
    title: raw.title || "",
    passageText: raw.passageText || null,
    speakerAName: raw.speakerAName || "Speaker A",
    speakerAText: raw.speakerAText || null,
    speakerBName: raw.speakerBName || "Speaker B",
    speakerBText: raw.speakerBText || null,
    imageUrl: raw.imageUrl || null,
    audioUrl: raw.audioUrl || null,
    sectionIndex,
    sectionTitle,
    pageIndex,
    questions: [], // filled in by normalizeTest with globally-numbered questions
  };
}

/** Normalize the full document into { ...testMeta, sections, pages, questionIndex, totalMarks }. */
function normalizeTest(raw) {
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  if (rawSections.length === 0) {
    throw new Error("No sections found in Selected_Mock_Tests.json");
  }

  const pages = []; // one entry per group, in overall order
  const questionIndex = []; // flat, globally-numbered, one entry per question
  let globalQuestionCounter = 0;

  const sections = rawSections.map((rawSection, sectionIndex) => {
    const sectionTitle = rawSection.title || `Section ${sectionIndex + 1}`;
    const groups = (rawSection.groups || []).map((rawGroup) => {
      const pageIndex = pages.length;
      const group = normalizeGroup(rawGroup, sectionIndex, sectionTitle, pageIndex);

      group.questions = (rawGroup.questions || []).map((rawQ) => {
        const q = normalizeQuestion(rawQ, globalQuestionCounter);
        questionIndex.push({
          id: q.id,
          order: q.order,
          pageIndex,
          sectionIndex,
          sectionTitle,
        });
        globalQuestionCounter += 1;
        return q;
      });

      pages.push(group);
      return group;
    });
    return { id: rawSection.id, title: sectionTitle, groups };
  });

  const totalMarks = questionIndex.reduce((sum, entry) => {
    const group = pages[entry.pageIndex];
    const q = group.questions.find((qq) => qq.id === entry.id);
    return sum + (q ? q.marks : 0);
  }, 0);

  return {
    id: raw.id,
    title: raw.title || "Mock Test",
    category: raw.categoryName || "General",
    topic: raw.topic || "",
    noTimeLimit: !!raw.noTimeLimit,
    durationMinutes: typeof raw.duration === "number" ? raw.duration : 60,
    passMarks: typeof raw.passMarks === "number" ? raw.passMarks : null,
    resultSettings: normalizeResultSettings(raw.resultSettings),
    securitySettings: normalizeSecuritySettings(raw.securitySettings),
    totalMarks,
    totalQuestions: questionIndex.length,
    sections,
    pages, // ordered list of groups — Next/Previous move through THIS array
    questionIndex, // flat, globally-numbered — the palette is built from THIS array
  };
}

/** Defaults match the spec's own "default these to ON for JFT exam mode" instruction — every restriction on, a 3-violation warning threshold, matching the pre-existing EXAM_INTEGRITY_CONFIG in security.js exactly so behavior doesn't silently change for any test that predates this admin-configurable version. */
const DEFAULT_SECURITY_SETTINGS = {
  disableTextSelection: true,
  disableCopy: true,
  disableCut: true,
  disablePaste: true,
  disableContextMenu: true,
  disablePrint: true,
  requestFullscreen: true,
  detectFullscreenExit: true,
  detectTabSwitch: true,
  blockShortcuts: true,
  trackSecurityEvents: true,
  maxViolations: 3,
  thresholdAction: "warn", // "continue" | "warn" | "auto_submit"
};

function normalizeSecuritySettings(raw) {
  return { ...DEFAULT_SECURITY_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
}

const DEFAULT_RESULT_SETTINGS = {
  titleJa: "試験の結果をお知らせします。",
  titleEn: "Your test results are as follows.",
  minScore: 10,
  maxScore: 250,
  passingScore: 200,
  scoreMode: "raw", // "raw" | "percentage" | "scaled"
  rawMin: 0,
  rawMax: null, // null = use the test's own totalMarks
  finalMin: 10,
  finalMax: 250,
  passedJa: "あなたは日本語能力水準に達しました。",
  passedEn: "You were assessed to have reached the required Japanese language proficiency level.",
  failedJa: "あなたは日本語能力水準には達していないと判定されました。",
  failedEn: "You were assessed to have not reached the required Japanese language proficiency level.",
  sectionLabels: {
    "sec-scripts": { ja: "文字と語彙", en: "Script and Vocabulary" },
    "sec-conversation": { ja: "会話と表現", en: "Conversation and Expression" },
    "sec-listening": { ja: "聴解", en: "Listening Comprehension" },
    "sec-reading": { ja: "読解", en: "Reading Comprehension" },
  },
};

function normalizeResultSettings(raw) {
  const rs = raw && typeof raw === "object" ? raw : {};
  const sectionLabels = {};
  Object.keys(DEFAULT_RESULT_SETTINGS.sectionLabels).forEach((id) => {
    sectionLabels[id] = { ...DEFAULT_RESULT_SETTINGS.sectionLabels[id], ...((rs.sectionLabels || {})[id] || {}) };
  });
  // Any section id in the source that isn't one of the 4 known defaults (shouldn't happen given the fixed-section architecture, but don't silently drop it) still gets carried through as-is.
  Object.keys(rs.sectionLabels || {}).forEach((id) => {
    if (!sectionLabels[id]) sectionLabels[id] = rs.sectionLabels[id];
  });
  return { ...DEFAULT_RESULT_SETTINGS, ...rs, sectionLabels };
}

/** Public entry point: load (and memoize per testId) the normalized test. */
export async function loadTest(testId) {
  if (cachedTest && cachedTestId === testId) return cachedTest;
  const raw = await fetchExport(testId);
  cachedTest = normalizeTest(raw);
  cachedTestId = testId;
  return cachedTest;
}

export function getCachedTest() {
  return cachedTest;
}

/** Look up a question's {pageIndex, group, question} triple by question id — used for palette jump + scoring. */
export function findQuestionLocation(test, questionId) {
  const entry = test.questionIndex.find((e) => e.id === questionId);
  if (!entry) return null;
  const group = test.pages[entry.pageIndex];
  const question = group.questions.find((q) => q.id === questionId);
  return { entry, group, question };
}
