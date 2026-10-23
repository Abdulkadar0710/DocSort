import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const BUNDLE_BUCKET = 'bundles';

/**
 * Server-side client. Prefers the service-role key when present (bypasses RLS,
 * never reaches the browser) and otherwise falls back to the anon key, which
 * works against the permissive prototype policies in migration 002. The
 * fallback keeps the app runnable before any secret has been fetched.
 */
export function serverClient(): SupabaseClient {
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || anonKey;
  if (!key) {
    throw new Error(
      'Neither SUPABASE_SERVICE_ROLE_KEY nor NEXT_PUBLIC_SUPABASE_ANON_KEY is set',
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Browser client. Used only to PUT a bundle to a server-minted signed URL. */
let browser: SupabaseClient | null = null;
export function browserClient(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error('Supabase public env vars are not set');
  }
  browser ??= createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return browser;
}
