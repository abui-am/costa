import type { CookieOptions, Request, Response } from 'express'
import { createMobileSessionNonce } from './mobile-session-nonce.js'

/** Cookie: native app base URL to open after Google OAuth (e.g. costa://oauth). */
export const POST_OAUTH_APP_REDIRECT_COOKIE = 'costa_oauth_post_redirect'

function oauthFlowCookieOpts(): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 600_000,
    path: '/',
  }
}

/**
 * Accept `redirect_to` from `/api/auth/oauth/google?redirect_to=…` (URL-encoded).
 * Only **`costa:`** app URLs are allowed (prevents open redirects).
 */
export function parseIosStylePostOAuthRedirect(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }
  let s = raw.trim()
  try {
    s = decodeURIComponent(s)
  } catch {
    return null
  }
  if (s.length > 2048) {
    return null
  }
  try {
    const u = new URL(s)
    if (u.protocol !== 'costa:') {
      return null
    }
    u.hash = ''
    const host = u.hostname
    if (!host) {
      return null
    }
    const path = u.pathname === '/' ? '' : u.pathname
    return `costa://${host}${path}`
  } catch {
    return null
  }
}

export function setPostOAuthAppRedirectCookie(
  res: Response,
  appBaseUrl: string,
): void {
  res.cookie(POST_OAUTH_APP_REDIRECT_COOKIE, appBaseUrl, oauthFlowCookieOpts())
}

export function takePostOAuthAppRedirectCookie(
  req: Request,
  res: Response,
): string | null {
  const raw = req.cookies[POST_OAUTH_APP_REDIRECT_COOKIE]
  res.clearCookie(POST_OAUTH_APP_REDIRECT_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
  if (typeof raw !== 'string' || !raw.length) {
    return null
  }
  return parseIosStylePostOAuthRedirect(raw)
}

/**
 * Build the Supabase `redirectTo` URL for the OAuth callback.
 * When `appRedirect` is set (native flow), the target app URL is embedded as
 * `?redirect_to=…` so the callback can recover it even if cookies were dropped.
 */
export function buildGoogleOAuthCallbackUrl(
  publicBackendOrigin: string,
  appRedirect: string | null,
): string {
  const path = '/api/auth/oauth/google/callback'
  if (!appRedirect) {
    return `${publicBackendOrigin}${path}`
  }
  return `${publicBackendOrigin}${path}?redirect_to=${encodeURIComponent(appRedirect)}`
}

/** Prefer `redirect_to` query param (survives cookie loss), then fall back to cookie. */
export function resolveNativeAppRedirectTarget(
  req: Request,
  res: Response,
): string | null {
  const fromQuery = parseIosStylePostOAuthRedirect(req.query.redirect_to)
  const fromCookie = takePostOAuthAppRedirectCookie(req, res)
  return fromQuery ?? fromCookie
}

/**
 * Redirect the native app with a **one-time nonce** — no tokens in the URL.
 *
 * The nonce (`?code=<nonce>`) is stored server-side for 60 seconds.
 * The app calls `POST /api/auth/mobile/exchange` with the nonce to receive
 * the full session JSON over HTTPS, keeping tokens out of URLs entirely.
 *
 * On error (`payload` has an `error` key), the error string is passed directly
 * so the app can show it without an exchange round-trip.
 */
export function sendNativeOAuthCompletion(
  res: Response,
  appBaseUrl: string,
  payload: unknown,
): void {
  const isError =
    payload !== null &&
    typeof payload === 'object' &&
    'error' in (payload as object) &&
    typeof (payload as Record<string, unknown>).error === 'string'

  if (isError) {
    const errStr = encodeURIComponent(
      (payload as Record<string, unknown>).error as string,
    )
    res.redirect(302, `${appBaseUrl}?error=${errStr}`)
    return
  }

  const nonce = createMobileSessionNonce(payload)
  res.redirect(302, `${appBaseUrl}?code=${nonce}`)
}
