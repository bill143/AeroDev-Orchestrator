// lib/auth.ts
// Google sign-in / sign-out helpers built on Supabase Auth.
// The app NEVER stores passwords or tokens itself — Supabase owns the session and
// the user completes the Google login on Google's own page.

import { supabase } from './supabase';

export interface AppUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

// Begin the Google OAuth flow. This sends the browser to Google; on success Google
// redirects back to this app, where supabase (detectSessionInUrl) finishes login.
export async function signInWithGoogle(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Map the raw Supabase user into the small shape the UI needs.
function toAppUser(u: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null): AppUser | null {
  if (!u) return null;
  const meta = u.user_metadata ?? {};
  return {
    id: u.id,
    email: u.email ?? null,
    name: (meta.full_name as string) ?? (meta.name as string) ?? null,
    avatarUrl: (meta.avatar_url as string) ?? (meta.picture as string) ?? null,
  };
}

// Read the current user once (e.g. on first load).
export async function getCurrentUser(): Promise<AppUser | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return toAppUser(data.user as never);
}

// Subscribe to login/logout changes. Returns an unsubscribe function.
export function onAuthChange(cb: (user: AppUser | null) => void): () => void {
  if (!supabase) { cb(null); return () => {}; }
  const { data } = supabase.auth.onAuthStateChange((_event: string, session: unknown) => {
    const s = session as { user?: unknown } | null;
    cb(toAppUser((s?.user as never) ?? null));
  });
  return () => data.subscription.unsubscribe();
}
