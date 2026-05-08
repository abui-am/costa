import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCategoryColor } from '../utils/category-color.js'
import type { ParsedBillCost } from './bill-scan.js'

/**
 * Ensures a `category_id` for insert: reuse RAG match, or find/create `cost_categories`
 * by name (AI-created rows get `is_generated_by_ai`).
 */
export async function resolveCategoryIdsForItems(
  sb: SupabaseClient,
  userId: string,
  items: readonly ParsedBillCost[],
): Promise<ParsedBillCost[]> {
  const nameCache = new Map<string, string>()

  const out: ParsedBillCost[] = []
  for (const it of items) {
    if (it.category_id) {
      out.push(it)
      continue
    }

    const nameRaw = it.category.trim()
    const canon = !nameRaw || nameRaw === 'Unknown' ? 'Unknown' : nameRaw
    const cacheKey = canon.toLowerCase()

    let cid = nameCache.get(cacheKey)
    if (cid === undefined) {
      const resolved = await resolveOrCreateCategoryRow(
        sb,
        userId,
        canon,
        it.new_category_emoji,
        it.new_category_color,
      )
      if (!resolved) {
        throw Object.assign(
          new Error('Could not create or resolve expense category'),
          { statusCode: 503 },
        )
      }
      cid = resolved
      nameCache.set(cacheKey, cid)
    }

    out.push({ ...it, category: canon, category_id: cid })
  }
  return out
}

async function resolveOrCreateCategoryRow(
  sb: SupabaseClient,
  userId: string,
  name: string,
  emojiRaw: string | null | undefined,
  colorRaw: string | null | undefined,
): Promise<string | null> {
  const nameTrim = name.slice(0, 200)
  const emoji = (emojiRaw ?? '').trim().slice(0, 32)
  const colorParsed = parseCategoryColor(colorRaw ?? '')
  const color = colorParsed === null ? '' : colorParsed

  const { data: existing } = await sb
    .from('cost_categories')
    .select('id')
    .eq('user_id', userId)
    .eq('name', nameTrim)
    .maybeSingle()

  if (existing?.id) {
    return existing.id
  }

  const { data: created, error } = await sb
    .from('cost_categories')
    .insert({
      user_id: userId,
      name: nameTrim,
      emoji: emoji || '',
      color,
      is_generated_by_ai: true,
    })
    .select('id')
    .single()

  if (created?.id) {
    return created.id
  }

  if (error) {
    const { data: again } = await sb
      .from('cost_categories')
      .select('id')
      .eq('user_id', userId)
      .eq('name', nameTrim)
      .maybeSingle()
    return again?.id ?? null
  }

  return null
}
