import { Router, type Request, type Response } from 'express'
import type { Session, User } from '@supabase/supabase-js'
import {
  createSupabaseOAuthClient,
  createSupabaseWithAccessToken,
  getSupabaseAnon,
} from '../supabase.js'
import { createExpressOAuthStorage } from '../oauth-cookie-storage.js'
import {
  buildGoogleOAuthCallbackUrl,
  parseIosStylePostOAuthRedirect,
  resolveNativeAppRedirectTarget,
  sendNativeOAuthCompletion,
  setPostOAuthAppRedirectCookie,
} from '../utils/oauth-ios-redirect.js'
import { consumeMobileSessionNonce } from '../utils/mobile-session-nonce.js'

export const authRouter = Router()

function getBearerToken(req: Request): string | null {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return null
  }
  const token = auth.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

function requirePublicBackendOrigin(): string | null {
  const raw = process.env.PUBLIC_BACKEND_URL?.trim()
  if (!raw) {
    return null
  }
  return raw.replace(/\/$/, '')
}

function authJson(user: User, session: Session) {
  return {
    user: {
      id: user.id,
      email: user.email,
      app_metadata: user.app_metadata,
      user_metadata: user.user_metadata,
    },
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      token_type: session.token_type,
    },
  }
}

authRouter.post('/login', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' })
    return
  }

  let supabase
  try {
    supabase = getSupabaseAnon()
  } catch {
    res.status(503).json({ error: 'Supabase is not configured' })
    return
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    res.status(401).json({ error: error.message })
    return
  }

  if (!data.session || !data.user) {
    res.status(500).json({ error: 'Login succeeded but session was missing' })
    return
  }

  res.json(authJson(data.user, data.session))
})

/**
 * Shared PKCE bootstrap: sets cookies, returns Supabase/Google authorize URL.
 * On error, sends response and returns undefined.
 */
async function getGoogleOAuthAuthorizeUrl(
  req: Request,
  res: Response,
): Promise<string | undefined> {
  const origin = requirePublicBackendOrigin()
  if (!origin) {
    res.status(500).json({
      error:
        'PUBLIC_BACKEND_URL must be set (e.g. https://api.example.com or http://localhost:3222)',
    })
    return undefined
  }

  const appRedirect = parseIosStylePostOAuthRedirect(req.query.redirect_to)
  if (appRedirect) {
    setPostOAuthAppRedirectCookie(res, appRedirect)
  }

  const storage = createExpressOAuthStorage(req, res)
  let supabase: ReturnType<typeof createSupabaseOAuthClient>
  try {
    supabase = createSupabaseOAuthClient(storage)
  } catch {
    res.status(503).json({ error: 'Supabase is not configured' })
    return undefined
  }

  const redirectTo = buildGoogleOAuthCallbackUrl(origin, appRedirect)

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      scopes: 'email profile',
      ...(appRedirect
        ? {
            queryParams: {
              redirect_to: appRedirect,
            },
          }
        : {}),
    },
  })

  if (error) {
    res.status(502).json({ error: error.message })
    return undefined
  }

  if (!data?.url) {
    res.status(502).json({ error: 'OAuth did not return a redirect URL' })
    return undefined
  }

  return data.url
}

/**
 * JSON variant for Swagger/tooling — browser `fetch()` cannot follow OAuth 302 redirects (CORS).
 * Use Try it out here, then paste `url` into the same browser (same-origin cookies required).
 *
 * Redirect URLs must include:
 * `{PUBLIC_BACKEND_URL}/api/auth/oauth/google/callback`
 */
authRouter.get('/oauth/google/link', async (req, res) => {
  const url = await getGoogleOAuthAuthorizeUrl(req, res)
  if (!url) {
    return
  }
  res.json({
    url,
    hint: 'Swagger cannot follow the 302 OAuth redirect. Paste `url` into this browser’s address bar, then finish Google sign-in here.',
  })
})

/**
 * Start Google OAuth (PKCE): sets cookies then 302 redirect to Google (normal browser navigation).
 */
authRouter.get('/oauth/google', async (req, res) => {
  const url = await getGoogleOAuthAuthorizeUrl(req, res)
  if (!url) {
    return
  }
  res.redirect(302, url)
})

/**
 * OAuth callback: exchange ?code= for a session (cookies must present from /oauth/google).
 */
authRouter.get('/oauth/google/callback', async (req, res) => {
  const nativeRedirectBase = resolveNativeAppRedirectTarget(req, res)

  const errParam = req.query.error_description ?? req.query.error
  if (typeof errParam === 'string' && errParam.length > 0) {
    if (nativeRedirectBase) {
      sendNativeOAuthCompletion(res, nativeRedirectBase, { error: errParam })
      return
    }
    res.status(401).json({ error: errParam })
    return
  }

  const code = req.query.code
  if (typeof code !== 'string' || !code) {
    const msg = 'Missing authorization code (expected ?code=)'
    if (nativeRedirectBase) {
      sendNativeOAuthCompletion(res, nativeRedirectBase, { error: msg })
      return
    }
    res.status(400).json({ error: msg })
    return
  }

  const storage = createExpressOAuthStorage(req, res)
  let supabase: ReturnType<typeof createSupabaseOAuthClient>
  try {
    supabase = createSupabaseOAuthClient(storage)
  } catch {
    const msg = 'Supabase is not configured'
    if (nativeRedirectBase) {
      sendNativeOAuthCompletion(res, nativeRedirectBase, { error: msg })
      return
    }
    res.status(503).json({ error: msg })
    return
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    if (nativeRedirectBase) {
      sendNativeOAuthCompletion(res, nativeRedirectBase, { error: error.message })
      return
    }
    res.status(401).json({ error: error.message })
    return
  }

  const session = data.session
  const user = data.user

  if (!session || !user) {
    const msg = 'OAuth exchange succeeded but session was missing'
    if (nativeRedirectBase) {
      sendNativeOAuthCompletion(res, nativeRedirectBase, { error: msg })
      return
    }
    res.status(500).json({ error: msg })
    return
  }

  const body = authJson(user, session)
  if (nativeRedirectBase) {
    sendNativeOAuthCompletion(res, nativeRedirectBase, body)
    return
  }

  res.json(body)
})

/**
 * Exchange a one-time nonce (received in the costa:// redirect) for a session.
 * Tokens travel only over HTTPS in the response body — never in a URL.
 * The nonce is valid for 60 seconds and is single-use.
 */
authRouter.post('/mobile/exchange', (req, res) => {
  const code =
    typeof req.body?.code === 'string' ? req.body.code.trim() : ''
  if (!code) {
    res.status(400).json({ error: 'code is required' })
    return
  }

  const payload = consumeMobileSessionNonce(code)
  if (payload === null) {
    res.status(401).json({ error: 'Invalid or expired code' })
    return
  }

  res.json(payload)
})

authRouter.post('/logout', async (req, res) => {
  const token = getBearerToken(req)
  if (!token) {
    res
      .status(401)
      .json({ error: 'Authorization: Bearer <access_token> is required' })
    return
  }

  let supabase
  try {
    supabase = createSupabaseWithAccessToken(token)
  } catch {
    res.status(503).json({ error: 'Supabase is not configured' })
    return
  }

  const { error } = await supabase.auth.signOut({ scope: 'global' })

  if (error) {
    res.status(400).json({ error: error.message })
    return
  }

  res.status(204).send()
})
