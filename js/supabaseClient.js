/**
 * supabaseClient.js
 * One shared Supabase client for the whole student site. Loaded from a
 * CDN (esm.sh) since this project has no bundler/build step — see
 * SETUP_SUPABASE_AUTH.md §5 if you'd rather vendor the library locally.
 *
 * persistSession: true + autoRefreshToken: true is what gives us
 * "remember login" (§6 of the spec) for free — supabase-js stores the
 * refresh token in localStorage itself and silently refreshes the
 * access token, so a returning visitor with a still-valid session skips
 * the login screen entirely (see auth.js's getSession() check).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js?v=4";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
