// supabase/functions/admin-revoke-session/index.ts
//
// The ONE place the Supabase service-role key is used. Deployed as a
// Supabase Edge Function (runs on Supabase's servers, never in the
// browser). Revoking a user's active sessions requires the Auth Admin
// API, which requires the service-role key — that key must never reach
// client JS (see SETUP_SUPABASE_AUTH.md §7).
//
// Called from admin/js/users.js via supabase.functions.invoke(), which
// automatically forwards the calling admin's own JWT in the
// Authorization header — we re-verify that JWT here AND check the
// caller is actually an admin before doing anything, so this endpoint
// can't be used by a non-admin who merely knows the URL.
//
// Deploy:
//   supabase functions deploy admin-revoke-session
// Required secrets (set via `supabase secrets set`, NOT in this file):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both auto-available to
//   Edge Functions as env vars — no manual secret needed for these two).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerToken = authHeader.replace("Bearer ", "");
    if (!callerToken) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Client scoped to the CALLER's own token — used only to verify who
    // is calling and whether they're an admin, via RLS (is_admin()).
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: callerUser, error: callerErr } = await callerClient.auth.getUser(callerToken);
    if (callerErr || !callerUser?.user) {
      return json({ error: "Invalid session" }, 401);
    }

    const { data: isAdminRow, error: adminCheckErr } = await callerClient
      .from("admins")
      .select("user_id")
      .eq("user_id", callerUser.user.id)
      .maybeSingle();
    if (adminCheckErr || !isAdminRow) {
      return json({ error: "Admin role required" }, 403);
    }

    const { targetUserId, disable } = await req.json();
    if (!targetUserId) {
      return json({ error: "targetUserId is required" }, 400);
    }

    // Service-role client — the only client in this whole project ever
    // constructed with the service-role key, and it only exists inside
    // this server-side function.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Revoke every refresh token / active session for the target user.
    const { error: signOutErr } = await adminClient.auth.admin.signOut(targetUserId, "global");
    if (signOutErr) {
      return json({ error: `Failed to revoke sessions: ${signOutErr.message}` }, 500);
    }

    if (disable) {
      const { error: disableErr } = await adminClient
        .from("users")
        .update({ status: "disabled" })
        .eq("id", targetUserId);
      if (disableErr) {
        return json({ error: `Sessions revoked, but disabling the row failed: ${disableErr.message}` }, 500);
      }
    }

    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
