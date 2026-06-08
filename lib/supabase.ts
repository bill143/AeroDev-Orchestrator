// lib/supabase.ts
// Browser-side Supabase client.
//
// These two values are the PUBLIC, publishable credentials — they are designed to
// ship in the browser and are NOT secret (your real protection is Row-Level
// Security in the database, enabled by supabase-schema.sql). They are different
// from the GEMINI_API_KEY (server-only) and from the Supabase "service_role" key
// (server-only, NEVER put in the browser).
//
// REQUIRED ENV VARS (set in your host dashboard; the NEXT_PUBLIC_ prefix is what
// makes them available to the browser in Next.js):
//   NEXT_PUBLIC_SUPABASE_URL       = https://YOUR-PROJECT.supabase.co
//   NEXT_PUBLIC_SUPABASE_ANON_KEY  = your project's publishable/anon key

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Read env safely whether or not Node types are present in the toolchain.
const env: Record<string, string | undefined> =
  ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env) ?? {};

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// If either is missing, we expose `null` and the app runs in local-only mode
// (no login, in-memory data) instead of crashing. This keeps the demo working.
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true, // completes the Google redirect handshake
        },
      })
    : null;

export const isSupabaseConfigured = (): boolean => supabase !== null;
