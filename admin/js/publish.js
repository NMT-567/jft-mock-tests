/**
 * publish.js
 * Bridges the local-editor draft (unchanged — still localStorage, still
 * built the same way it always has been) to Supabase's `tests` table.
 * Reuses admin/js/export.js's buildExportDocument(draft) so the content
 * stored in `tests.content` is byte-for-byte the same shape the old
 * downloadExport() produced — js/loader.js doesn't know or care that its
 * source changed from a static file to a Supabase row.
 *
 * One Supabase test row per local draft, matched by local_draft_id
 * (draft.id — see supabase/migrations/0006_fix_test_id_mapping.sql),
 * NOT by tests.id itself: tests.id is a real, Supabase-generated UUID,
 * while draft.id looks like "test-mskidqg4-wvi7tt" (generateId()) and
 * is never a valid UUID. Republishing the same draft finds and updates
 * its existing row via this mapping, rather than erroring or
 * duplicating.
 */
import { supabase } from "../../js/supabaseClient.js?v=1";
import { buildExportDocument } from "./export.js?v=8";

/**
 * @param {object} draft - the local admin draft
 * @param {"draft"|"published"} status
 * @param {string} adminUserId - unused now (the RPC derives the writer from auth.uid() itself), kept in the signature so editor.js's call site doesn't need to change
 */
export async function publishDraftToSupabase(draft, status, adminUserId) {
  const doc = buildExportDocument(draft);
  const totalQuestions = doc.sections.reduce(
    (sum, s) => sum + s.groups.reduce((gs, g) => gs + g.questions.length, 0),
    0
  );
  const totalPoints = doc.sections.reduce(
    (sum, s) => sum + s.groups.reduce((gs, g) => gs + g.questions.reduce((qs, q) => qs + (q.marks || 0), 0), 0),
    0
  );

  // Goes through the publish_test() RPC, NOT a direct
  // .from("tests").upsert(...) — see supabase/migrations/0005_publish_function.sql
  // for why (a plain upsert whose payload includes `content` requires
  // SELECT privilege on that column, which 0003 deliberately withholds).
  //
  // p_local_draft_id (Session 20), NOT p_id: draft.id looks like
  // "test-mskidqg4-wvi7tt" (see admin/js/components.js's generateId()) —
  // never a UUID. tests.id is uuid-typed and Supabase-generated; the RPC
  // finds/creates the real row by matching this stable local_draft_id
  // instead, via supabase/migrations/0006_fix_test_id_mapping.sql. This
  // is what makes republishing update the same row rather than either
  // erroring outright or creating a duplicate.
  const { data, error } = await supabase.rpc("publish_test", {
    p_local_draft_id: draft.id,
    p_title: doc.title,
    p_category_name: doc.categoryName ?? null,
    p_status: status,
    p_content: doc,
    p_total_questions: totalQuestions,
    p_total_points: totalPoints,
  });
  if (error) throw error;
  return data;
}

/** List every Supabase test row (admins see all statuses, per RLS). */
export async function listSupabaseTests() {
  const { data, error } = await supabase
    .from("tests")
    .select("id, title, category_name, status, total_questions, total_points, updated_at, published_at")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function setTestStatus(testId, status) {
  const { error } = await supabase.from("tests").update({ status, updated_at: new Date().toISOString() }).eq("id", testId);
  if (error) throw error;
}

export async function deleteSupabaseTest(testId) {
  const { error } = await supabase.from("tests").delete().eq("id", testId);
  if (error) throw error;
}
