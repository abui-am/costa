import type { SupportedStorage } from '@supabase/auth-js'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let anonClient: SupabaseClient | undefined
let adminClient: SupabaseClient | undefined

export function getSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL
  if (!url) {
    throw new Error('SUPABASE_URL is not set')
  }
  return url
}

function anonOrPublishableKey(): string | undefined {
  return process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY
}

/** Supabase client with the caller's JWT (logout, protected calls). Always create per request — not shared singleton. */
/**
 * Supabase Auth client configured for OAuth PKCE. Pass storage that survives redirect
 * (cookie adapter from `createExpressOAuthStorage`).
 */
export function createSupabaseOAuthClient(
  storage: SupportedStorage,
): SupabaseClient {
  const key = anonOrPublishableKey()
  if (!key) {
    throw new Error(
      'SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY is required',
    )
  }
  return createClient(getSupabaseUrl(), key, {
    auth: {
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      autoRefreshToken: false,
      storage,
    },
  })
}

export function createSupabaseWithAccessToken(accessToken: string): SupabaseClient {
  const key = anonOrPublishableKey()
  if (!key) {
    throw new Error(
      'SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY is required'
    )
  }
  return createClient(getSupabaseUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  })
}

/**
 * Anon (publishable) key client. Respects RLS.
 * Use `client.auth.setSession` / user JWT when acting as a logged-in user.
 */
export function getSupabaseAnon(): SupabaseClient {
  const key = anonOrPublishableKey()
  if (!key) {
    throw new Error(
      'SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY is required'
    )
  }
  if (!anonClient) {
    anonClient = createClient(getSupabaseUrl(), key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return anonClient
}

/**
 * Service role client. Bypasses RLS — use only on the server; never expose the key to clients.
 */
export function getSupabaseAdmin(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  }
  if (!adminClient) {
    adminClient = createClient(getSupabaseUrl(), key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return adminClient
}

export function getSupabaseConfigStatus(): {
  url: boolean
  anonKey: boolean
  publishableKey: boolean
  serviceRoleKey: boolean
  ready: boolean
} {
  const url = Boolean(process.env.SUPABASE_URL)
  const anonKey = Boolean(process.env.SUPABASE_ANON_KEY)
  const publishableKey = Boolean(process.env.SUPABASE_PUBLISHABLE_KEY)
  const serviceRoleKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  const hasPublicClientKey = Boolean(anonOrPublishableKey())
  return {
    url,
    anonKey,
    publishableKey,
    serviceRoleKey,
    ready: url && (hasPublicClientKey || serviceRoleKey),
  }
}
