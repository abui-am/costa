import { Router } from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAuth } from '../middleware/require-auth.js'
import { normalizeSpentOnInput } from '../utils/spent-on.js'
import { nextMonthFirstIso, normalizeBillingMonthInput } from '../utils/billing-month.js'
import { parsePaymentMethod, PAYMENT_METHOD_VALUES } from '../utils/payment-method.js'
import {
  shapeCostsForApi,
  shapeExpenseForApi,
  shapeExpensesForApi,
} from '../utils/cost-api-shape.js'

export const expenseRouter = Router()

expenseRouter.use(requireAuth)

const EXPENSE_TABLE = 'expenses' as const
const COST_TABLE = 'costs' as const
const CHARGE_TABLE = 'expense_charges' as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const CHARGE_TYPES = ['tax', 'service_charge'] as const
const CHARGE_AMOUNT_TYPES = ['percentage', 'fix_amount'] as const

type ChargeType = (typeof CHARGE_TYPES)[number]
type ChargeAmountType = (typeof CHARGE_AMOUNT_TYPES)[number]

type ChargeInput = {
  type: ChargeType
  amount_type: ChargeAmountType
  amount: number
  currency?: string | null
}

const COST_SELECT =
  '*, cost_categories(id, emoji, name, is_generated_by_ai, color)' as const

const EXPENSE_SELECT =
  `*, costs(${COST_SELECT}), expense_charges(*)` as const

/** Normalize date input: accepts YYYY-MM-DD or YYYY-MM (→ day 1). Returns null on invalid. */
function normalizeExpenseDateInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return normalizeSpentOnInput(raw) ?? normalizeBillingMonthInput(raw)
}

/** Validate and parse a charges array from request body. Returns parsed array or an error string. */
function parseChargesInput(raw: unknown): ChargeInput[] | string {
  if (!Array.isArray(raw)) return 'charges must be an array'
  const out: ChargeInput[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>
    if (!item || typeof item !== 'object') {
      return `charges[${i}] must be an object`
    }
    if (!CHARGE_TYPES.includes(item.type as ChargeType)) {
      return `charges[${i}].type must be one of: ${CHARGE_TYPES.join(', ')}`
    }
    if (!CHARGE_AMOUNT_TYPES.includes(item.amount_type as ChargeAmountType)) {
      return `charges[${i}].amount_type must be one of: ${CHARGE_AMOUNT_TYPES.join(', ')}`
    }
    const amtRaw = item.amount
    const amount =
      typeof amtRaw === 'number'
        ? amtRaw
        : typeof amtRaw === 'string'
          ? Number(amtRaw)
          : NaN
    if (!Number.isFinite(amount) || amount < 0) {
      return `charges[${i}].amount must be a non-negative number`
    }
    if (item.amount_type === 'percentage' && amount > 100) {
      return `charges[${i}].amount must be between 0 and 100 for percentage`
    }
    const currency =
      typeof item.currency === 'string' && item.currency.trim()
        ? item.currency.trim().toUpperCase().slice(0, 12)
        : null
    out.push({ type: item.type as ChargeType, amount_type: item.amount_type as ChargeAmountType, amount, currency })
  }
  return out
}

// ── POST / — create expense + line items ────────────────────────────────────

expenseRouter.post('/', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const user = res.locals.authUser
  const sb = res.locals.sbAuthClient

  const dateStr = normalizeExpenseDateInput(body.date)
  if (!dateStr) {
    res.status(400).json({
      error: 'date is required (YYYY-MM-DD or YYYY-MM → stored as day 1 of month)',
    })
    return
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 500) : ''
  const location =
    typeof body.location === 'string' ? body.location.trim().slice(0, 500) : ''
  const notes =
    typeof body.notes === 'string' && body.notes.trim()
      ? body.notes.trim().slice(0, 8000)
      : null
  const paymentMethod = parsePaymentMethod(
    typeof body.payment_method === 'string' ? body.payment_method : null,
  )
  const isDraft = body.is_draft === true

  const rawConf = body.confidence_score
  let confidenceScore: number | null = null
  if (rawConf !== undefined && rawConf !== null) {
    const n = typeof rawConf === 'number' ? rawConf : Number(rawConf)
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      res.status(400).json({ error: 'confidence_score must be a number between 0 and 1' })
      return
    }
    confidenceScore = n
  }

  const costsInput = Array.isArray(body.costs) ? body.costs : []
  if (costsInput.length === 0) {
    res.status(400).json({ error: 'costs must be a non-empty array of line items' })
    return
  }

  // Validate each line item
  type CostLine = {
    name: string
    category_id: string
    amount: number
    currency: string
    qty: number
  }
  const costLines: CostLine[] = []

  for (let i = 0; i < costsInput.length; i++) {
    const line = costsInput[i] as Record<string, unknown>

    const lineName =
      typeof line.name === 'string' ? line.name.trim().slice(0, 500) : ''
    if (!lineName) {
      res.status(400).json({ error: `costs[${i}].name is required` })
      return
    }

    const catId = typeof line.category_id === 'string' ? line.category_id.trim() : ''
    if (!catId || !UUID_RE.test(catId)) {
      res.status(400).json({
        error: `costs[${i}].category_id must be a valid UUID from cost_categories`,
      })
      return
    }

    const amtRaw = line.amount
    const amount =
      typeof amtRaw === 'number'
        ? amtRaw
        : typeof amtRaw === 'string'
          ? Number(amtRaw)
          : NaN
    if (!Number.isFinite(amount) || amount < 0) {
      res.status(400).json({
        error: `costs[${i}].amount must be a non-negative number`,
      })
      return
    }

    const currency =
      typeof line.currency === 'string' && line.currency.trim()
        ? line.currency.trim().toUpperCase().slice(0, 12)
        : 'USD'

    const qtyRaw = line.qty
    const qty =
      qtyRaw !== undefined && qtyRaw !== null
        ? typeof qtyRaw === 'number'
          ? qtyRaw
          : typeof qtyRaw === 'string'
            ? Number(qtyRaw)
            : NaN
        : 1
    if (!Number.isFinite(qty) || qty <= 0) {
      res.status(400).json({ error: `costs[${i}].qty must be a positive number` })
      return
    }

    costLines.push({ name: lineName, category_id: catId, amount, currency, qty })
  }

  // Validate charges (optional)
  let chargeLines: ChargeInput[] = []
  if ('charges' in body && body.charges !== undefined) {
    const parsed = parseChargesInput(body.charges)
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed })
      return
    }
    chargeLines = parsed
  }

  // Verify all category IDs belong to the user
  const catIds = [...new Set(costLines.map((l) => l.category_id))]
  const { data: catRows, error: catErr } = await sb
    .from('cost_categories')
    .select('id')
    .in('id', catIds)

  if (catErr) {
    res.status(502).json({ error: catErr.message })
    return
  }
  const foundIds = new Set((catRows ?? []).map((r: { id: string }) => r.id))
  const missingCat = catIds.find((id) => !foundIds.has(id))
  if (missingCat) {
    res.status(400).json({
      error: `category_id ${missingCat} not found in your cost_categories`,
    })
    return
  }

  // Insert expense
  const { data: expense, error: expErr } = await sb
    .from(EXPENSE_TABLE)
    .insert({
      user_id: user.id,
      name,
      date: dateStr,
      location,
      notes,
      payment_method: paymentMethod,
      is_draft: isDraft,
      confidence_score: confidenceScore,
    })
    .select('*')
    .single()

  if (expErr || !expense) {
    res.status(400).json({ error: expErr?.message ?? 'Failed to create expense' })
    return
  }

  const expId = (expense as Record<string, unknown>).id as string

  // Insert cost lines
  const costRows = costLines.map((line) => ({
    ...line,
    user_id: user.id,
    expense_id: expId,
  }))

  const { data: costs, error: costsErr } = await sb
    .from(COST_TABLE)
    .insert(costRows)
    .select(COST_SELECT)

  if (costsErr) {
    await sb.from(EXPENSE_TABLE).delete().eq('id', expId)
    res.status(400).json({ error: costsErr.message })
    return
  }

  // Insert charges (optional)
  let charges: Record<string, unknown>[] = []
  if (chargeLines.length > 0) {
    const chargeInserts = chargeLines.map((ch) => ({
      expense_id: expId,
      user_id: user.id,
      type: ch.type,
      amount_type: ch.amount_type,
      amount: ch.amount,
      currency: ch.currency ?? null,
    }))
    const { data: chargeData, error: chargeErr } = await sb
      .from(CHARGE_TABLE)
      .insert(chargeInserts)
      .select('*')
    if (chargeErr) {
      await sb.from(EXPENSE_TABLE).delete().eq('id', expId)
      res.status(400).json({ error: chargeErr.message })
      return
    }
    charges = (chargeData ?? []) as Record<string, unknown>[]
  }

  res.status(201).json({
    expense: shapeExpenseForApi({
      ...(expense as Record<string, unknown>),
      costs: (costs ?? []) as Record<string, unknown>[],
      expense_charges: charges,
    }),
    costs: shapeCostsForApi((costs ?? []) as Record<string, unknown>[]),
  })
})

// ── GET / — list expenses (with embedded costs) ─────────────────────────────

expenseRouter.get('/', async (req, res) => {
  const sb = res.locals.sbAuthClient

  let query = sb
    .from(EXPENSE_TABLE)
    .select(EXPENSE_SELECT)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })

  const monthFilter =
    typeof req.query.month === 'string'
      ? normalizeBillingMonthInput(req.query.month)
      : null
  if (monthFilter) {
    const endExclusive = nextMonthFirstIso(monthFilter)
    query = query.gte('date', monthFilter).lt('date', endExclusive)
  }

  // ?draft=true → drafts only | ?draft=false → posted only | omit → all
  const draftParam = req.query.draft
  if (draftParam === 'true') {
    query = query.eq('is_draft', true)
  } else if (draftParam === 'false') {
    query = query.eq('is_draft', false)
  }

  const { data, error } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({
    expenses: shapeExpensesForApi((data ?? []) as Record<string, unknown>[]),
  })
})

// ── GET /:id — single expense with embedded costs ────────────────────────────

expenseRouter.get('/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : ''
  if (!id) {
    res.status(400).json({ error: 'missing id' })
    return
  }

  const { data, error } = await res.locals.sbAuthClient
    .from(EXPENSE_TABLE)
    .select(EXPENSE_SELECT)
    .eq('id', id)
    .maybeSingle()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }
  if (!data) {
    res.status(404).json({ error: 'not found' })
    return
  }

  res.json({ expense: shapeExpenseForApi(data as Record<string, unknown>) })
})

// ── PATCH /:id — update expense-level fields ─────────────────────────────────

expenseRouter.patch('/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : ''
  if (!id) {
    res.status(400).json({ error: 'missing id' })
    return
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'JSON body expected' })
    return
  }

  const sb = res.locals.sbAuthClient

  const patch: Record<string, unknown> = {}

  if ('date' in body) {
    const d = normalizeExpenseDateInput(body.date)
    if (!d) {
      res.status(400).json({ error: 'invalid date (use YYYY-MM-DD or YYYY-MM)' })
      return
    }
    patch.date = d
  }
  if ('name' in body) {
    if (typeof body.name !== 'string') {
      res.status(400).json({ error: 'name must be a string' })
      return
    }
    patch.name = body.name.trim().slice(0, 500)
  }
  if ('location' in body) {
    if (typeof body.location !== 'string') {
      res.status(400).json({ error: 'location must be a string' })
      return
    }
    patch.location = body.location.trim().slice(0, 500)
  }
  if ('notes' in body) {
    if (body.notes !== null && typeof body.notes !== 'string') {
      res.status(400).json({ error: 'notes must be a string or null' })
      return
    }
    patch.notes = body.notes === null ? null : (body.notes as string).trim().slice(0, 8000) || null
  }
  if ('payment_method' in body) {
    if (typeof body.payment_method !== 'string' && body.payment_method !== null) {
      res.status(400).json({ error: 'payment_method must be a string' })
      return
    }
    const pm = parsePaymentMethod(
      body.payment_method === null ? '' : (body.payment_method as string),
    )
    if (!PAYMENT_METHOD_VALUES.includes(pm)) {
      res.status(400).json({
        error: `payment_method must be one of: ${PAYMENT_METHOD_VALUES.join(', ')}`,
      })
      return
    }
    patch.payment_method = pm
  }
  if ('is_draft' in body) {
    if (typeof body.is_draft !== 'boolean') {
      res.status(400).json({ error: 'is_draft must be a boolean' })
      return
    }
    patch.is_draft = body.is_draft
  }
  if ('confidence_score' in body) {
    if (body.confidence_score === null) {
      patch.confidence_score = null
    } else {
      const n =
        typeof body.confidence_score === 'number'
          ? body.confidence_score
          : Number(body.confidence_score)
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        res.status(400).json({ error: 'confidence_score must be a number between 0 and 1, or null' })
        return
      }
      patch.confidence_score = n
    }
  }

  // charges: if present → replace all for this expense (empty array = clear)
  let newCharges: ChargeInput[] | null = null
  if ('charges' in body && body.charges !== undefined) {
    const parsed = parseChargesInput(body.charges)
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed })
      return
    }
    newCharges = parsed
  }

  const hasScalarPatch = Object.keys(patch).length > 0
  if (!hasScalarPatch && newCharges === null) {
    res.status(400).json({
      error: 'no recognized fields (date, name, location, notes, payment_method, is_draft, confidence_score, charges)',
    })
    return
  }

  if (hasScalarPatch) {
    patch.updated_at = new Date().toISOString()

    const { error: updateErr } = await sb
      .from(EXPENSE_TABLE)
      .update(patch as never)
      .eq('id', id)

    if (updateErr) {
      res.status(400).json({ error: updateErr.message })
      return
    }
  }

  // Replace charges if provided
  if (newCharges !== null) {
    const userId = res.locals.authUser.id

    const { error: delErr } = await sb
      .from(CHARGE_TABLE)
      .delete()
      .eq('expense_id', id)

    if (delErr) {
      res.status(400).json({ error: delErr.message })
      return
    }

    if (newCharges.length > 0) {
      const chargeInserts = newCharges.map((ch) => ({
        expense_id: id,
        user_id: userId,
        type: ch.type,
        amount_type: ch.amount_type,
        amount: ch.amount,
        currency: ch.currency ?? null,
      }))
      const { error: chargeErr } = await sb.from(CHARGE_TABLE).insert(chargeInserts)
      if (chargeErr) {
        res.status(400).json({ error: chargeErr.message })
        return
      }
    }
  }

  const { data, error } = await sb
    .from(EXPENSE_TABLE)
    .select(EXPENSE_SELECT)
    .eq('id', id)
    .maybeSingle()

  if (error) {
    res.status(400).json({ error: error.message })
    return
  }
  if (!data) {
    res.status(404).json({ error: 'not found' })
    return
  }

  res.json({ expense: shapeExpenseForApi(data as Record<string, unknown>) })
})

// ── DELETE /:id — delete expense (cascades to costs) ─────────────────────────

expenseRouter.delete('/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : ''
  if (!id) {
    res.status(400).json({ error: 'missing id' })
    return
  }

  const { data, error } = await res.locals.sbAuthClient
    .from(EXPENSE_TABLE)
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }
  if (!data) {
    res.status(404).json({ error: 'not found' })
    return
  }

  res.status(204).send()
})

/** Create 1 expense + N costs (+ optional charges) atomically. */
export async function createExpenseWithCosts(params: {
  sb: SupabaseClient
  userId: string
  expense: {
    date: string
    name: string
    location: string
    notes: string | null
    payment_method: string
    is_draft?: boolean
    confidence_score?: number | null
  }
  costs: Array<{
    name: string
    category_id: string
    amount: number
    currency: string
    qty?: number
  }>
  charges?: ChargeInput[]
}): Promise<
  | { ok: true; expense: Record<string, unknown>; costs: Record<string, unknown>[]; charges: Record<string, unknown>[] }
  | { ok: false; status: number; message: string }
> {
  const { sb, userId, expense, costs, charges } = params

  const { data: expRow, error: expErr } = await sb
    .from(EXPENSE_TABLE)
    .insert({ user_id: userId, ...expense })
    .select('*')
    .single()

  if (expErr || !expRow) {
    return { ok: false, status: 400, message: expErr?.message ?? 'Failed to create expense' }
  }

  const expId = (expRow as Record<string, unknown>).id as string

  const costRows = costs.map((c) => ({
    ...c,
    user_id: userId,
    expense_id: expId,
  }))

  const { data: costData, error: costErr } = await sb
    .from(COST_TABLE)
    .insert(costRows)
    .select(COST_SELECT)

  if (costErr) {
    await sb.from(EXPENSE_TABLE).delete().eq('id', expId)
    return { ok: false, status: 400, message: costErr.message }
  }

  let chargeRows: Record<string, unknown>[] = []
  if (charges && charges.length > 0) {
    const chargeInserts = charges.map((ch) => ({
      expense_id: expId,
      user_id: userId,
      type: ch.type,
      amount_type: ch.amount_type,
      amount: ch.amount,
      currency: ch.currency ?? null,
    }))
    const { data: chargeData, error: chargeErr } = await sb
      .from(CHARGE_TABLE)
      .insert(chargeInserts)
      .select('*')
    if (chargeErr) {
      await sb.from(EXPENSE_TABLE).delete().eq('id', expId)
      return { ok: false, status: 400, message: chargeErr.message }
    }
    chargeRows = (chargeData ?? []) as Record<string, unknown>[]
  }

  return {
    ok: true,
    expense: expRow as Record<string, unknown>,
    costs: (costData ?? []) as Record<string, unknown>[],
    charges: chargeRows,
  }
}
