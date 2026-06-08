// lib/supabase.ts — browser-side Supabase client.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Read as direct literals so Next.js inlines the NEXT_PUBLIC_* values at build time.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function isValidHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export const supabase: SupabaseClient | null =
  isValidHttpUrl(url) && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null;

export const isSupabaseConfigured = (): boolean => supabase !== null;