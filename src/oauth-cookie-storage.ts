import { createHash } from 'node:crypto'
import type { SupportedStorage } from '@supabase/auth-js'
import type { CookieOptions, Request, Response } from 'express'

function cookieSuffix(storageKey: string): string {
  return createHash('sha256').update(storageKey).digest('hex').slice(0, 48)
}

/** Cookie-safe name derived from Supabase auth storage keys (challenge/verifier, etc.). */
function cookieKey(storageKey: string): string {
  return `sb_o_${cookieSuffix(storageKey)}`
}

function baseCookieOpts(): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    /** PKCE verifier + session exchange completes within ~10 minutes */
    maxAge: 600_000,
    path: '/',
  }
}

/**
 * Persist PKCE state between initiating Google OAuth (Set-Cookie) and `/callback`
 * (incoming Cookie).
 */
export function createExpressOAuthStorage(
  req: Request,
  res: Response,
): SupportedStorage {
  return {
    isServer: true,
    getItem(key) {
      const name = cookieKey(key)
      const raw = req.cookies[name]
      return typeof raw === 'string' ? raw : raw == null ? null : String(raw)
    },
    setItem(key, value) {
      res.cookie(cookieKey(key), value, baseCookieOpts())
    },
    removeItem(key) {
      res.clearCookie(cookieKey(key), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      })
    },
  }
}
