/**
 * config.js
 * Public Supabase project config for the student site. The URL and
 * anon key are DESIGNED to be public — they are safe to ship in static
 * JS. What actually protects data is Postgres Row Level Security (see
 * supabase/migrations/0001_init.sql), not secrecy of these two values.
 * The service-role key (which WOULD be dangerous to expose) never
 * appears anywhere in this repo — see
 * supabase/functions/admin-revoke-session/index.ts.
 *
 * Fill these in after following SETUP_SUPABASE_AUTH.md §§1-4. Admin
 * pages import the same two constants from here too (see
 * admin/js/supabaseClient.js).
 */
export const SUPABASE_URL = "https://pdirimwbisdeustcxazy.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkaXJpbXdiaXNkZXVzdGN4YXp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxOTQwNjYsImV4cCI6MjEwMTc3MDA2Nn0.F8iLL8nodMmi1qBm45Lnm8aJP0m39VXmevD-X_PjSpY";
