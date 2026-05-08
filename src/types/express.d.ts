import type { SupabaseClient, User } from '@supabase/supabase-js'

declare global {
  namespace Express {
    interface Locals {
      /** Supabase client using the incoming Bearer JWT — RLS applies as authenticated user */
      sbAuthClient: SupabaseClient
      authUser: User
    }
  }
}

export {}
