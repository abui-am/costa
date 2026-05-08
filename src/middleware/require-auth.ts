import type { NextFunction, RequestHandler, Response } from 'express'
import { createSupabaseWithAccessToken } from '../supabase.js'

function bearerToken(req: Parameters<RequestHandler>[0]): string | null {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return null
  }
  const raw = auth.slice('Bearer '.length).trim()
  return raw.length ? raw : null
}

export const requireAuth: RequestHandler = async (
  req,
  res: Response<{ error: string }>,
  next: NextFunction,
) => {
  const token = bearerToken(req)
  if (!token) {
    res.status(401).json({ error: 'Authorization Bearer access token required' })
    return
  }

  let supabase
  try {
    supabase = createSupabaseWithAccessToken(token)
  } catch {
    res.status(503).json({ error: 'Supabase is not configured' })
    return
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired access token' })
    return
  }

  res.locals.sbAuthClient = supabase
  res.locals.authUser = user
  next()
}
