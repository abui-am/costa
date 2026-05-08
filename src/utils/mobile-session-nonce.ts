import { randomBytes } from 'node:crypto'

/**
 * In-memory store for single-use, short-lived nonces issued after a successful
 * OAuth code exchange. The nonce travels to the native app in the URL
 * (costa://oauth?code=<nonce>) so the app can call
 * POST /api/auth/mobile/exchange to receive the session over HTTPS — keeping
 * tokens out of URLs entirely.
 *
 * TTL: 60 seconds (more than enough for the app to call exchange).
 * Single-use: the entry is deleted on first successful read.
 * No tokens survive a server restart (intentional — user re-auths).
 *
 * For multi-instance deployments, replace with Redis or a DB table.
 */

const NONCE_TTL_MS = 60_000

interface NonceEntry {
  payload: unknown
  expiresAt: number
}

const store = new Map<string, NonceEntry>()

function pruneExpired(): void {
  const now = Date.now()
  for (const [k, v] of store) {
    if (v.expiresAt <= now) {
      store.delete(k)
    }
  }
}

/** Generate a cryptographically random URL-safe nonce and stash the payload. */
export function createMobileSessionNonce(payload: unknown): string {
  pruneExpired()
  const nonce = randomBytes(32).toString('base64url')
  store.set(nonce, { payload, expiresAt: Date.now() + NONCE_TTL_MS })
  return nonce
}

/**
 * Consume a nonce: returns the payload and deletes the entry.
 * Returns `null` if the nonce is unknown or expired.
 */
export function consumeMobileSessionNonce(nonce: string): unknown | null {
  const entry = store.get(nonce)
  if (!entry) {
    return null
  }
  store.delete(nonce)
  if (entry.expiresAt <= Date.now()) {
    return null
  }
  return entry.payload
}
