import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import multer from 'multer'
import { extractCostsFromBillImage, type BillExtractionMeta } from '../services/bill-scan.js'
import { extractCostsFromNaturalLanguage } from '../services/cost-from-text.js'
import { normalizeBillingMonthInput, nextMonthFirstIso } from '../utils/billing-month.js'
import { normalizeSpentOnInput } from '../utils/spent-on.js'
import {
  normalizedBillImageDataUrlMime,
  passesBillImageUpload,
} from '../utils/bill-upload-mime.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAuth } from '../middleware/require-auth.js'
import type { CostCategoryRow } from '../services/category-rag.js'
import { resolveCategoryIdsForItems } from '../services/resolve-or-create-category.js'
import { shapeCostForApi, shapeCostsForApi, shapeExpenseForApi } from '../utils/cost-api-shape.js'
import { parseCategoryColor } from '../utils/category-color.js'
import { parsePaymentMethod } from '../utils/payment-method.js'

export const costRouter = Router()

const COST_TABLE = 'costs' as const
const EXPENSE_TABLE = 'expenses' as const

const COST_CATEGORY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Include joined category + parent expense rows for API shape. */
const COST_SELECT =
  '*, cost_categories(id, emoji, name, is_generated_by_ai, color), expenses(id, date, name, location, payment_method, notes, confidence_score, is_draft)' as const

async function fetchCostCategoryNameById(
  sb: SupabaseClient,
  categoryId: string,
): Promise<string | null> {
  const { data, error } = await sb
    .from('cost_categories')
    .select('name')
    .eq('id', categoryId)
    .maybeSingle()
  if (error || !data || typeof data !== 'object') {
    return null
  }
  const name = (data as { name?: unknown }).name
  if (typeof name !== 'string' || !name.trim()) {
    return null
  }
  return name.trim()
}

async function fetchUserCostCategories(
  sb: SupabaseClient,
): Promise<CostCategoryRow[]> {
  const { data, error } = await sb
    .from('cost_categories')
    .select('id, emoji, name, is_generated_by_ai, color')
    .order('name', { ascending: true })
  if (error) {
    return []
  }
  const rows = (data ?? []) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: typeof r.id === 'string' ? r.id : '',
    emoji: typeof r.emoji === 'string' ? r.emoji : '',
    name: typeof r.name === 'string' ? r.name : '',
    color: typeof r.color === 'string' ? r.color : '',
    is_generated_by_ai: r.is_generated_by_ai === true,
  })) as CostCategoryRow[]
}

const CHARGE_TABLE = 'expense_charges' as const

type ChargeInput = {
  type: 'tax' | 'service_charge'
  amount_type: 'percentage' | 'fix_amount'
  amount: number
  currency?: string | null
}

/** Create one expense row + N cost rows (+ optional charges), rolling back the expense on failure. */
async function createExpenseWithCosts(params: {
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
    return {
      ok: false,
      status: 400,
      message: expErr?.message ?? 'Failed to create expense',
    }
  }

  const expId = (expRow as Record<string, unknown>).id as string
  const costRows = costs.map((c) => ({ ...c, user_id: userId, expense_id: expId }))

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

// ── Multer upload middleware ──────────────────────────────────────────────────

const billUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter(_req, _file, cb) {
    cb(null, true)
  },
})

costRouter.use(requireAuth)

const billingFieldsUpload = billUpload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'file', maxCount: 1 },
])

function uploadBillMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  billingFieldsUpload(req, res, (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : 'Upload rejected'
      res.status(400).json({ error: msg })
      return
    }

    type Files = { image?: Express.Multer.File[]; file?: Express.Multer.File[] }
    const fb = req.files as Files | undefined
    const picked = fb?.image?.[0] ?? fb?.file?.[0]
    Object.assign(req, { file: picked })

    if (picked?.buffer?.length && !passesBillImageUpload(picked)) {
      res.status(400).json({
        error:
          'Only JPEG, PNG, WebP, GIF, and HEIF/HEIC are allowed. HEIC uploads are converted server-side before analysis. In Swagger: body field **image** (or **file**), then choose your file.',
      })
      return
    }

    next()
  })
}

// ── Extraction helpers ───────────────────────────────────────────────────────

function extractionResponsePayload(meta: BillExtractionMeta, line_count: number) {
  return {
    merchant: meta.merchant,
    summary: meta.raw_bill_summary,
    transaction_date: meta.transaction_date,
    location: meta.location,
    payment_method: meta.payment_method,
    line_count,
  }
}

function extractionErrorPayload(meta: BillExtractionMeta) {
  return {
    merchant: meta.merchant,
    summary: meta.raw_bill_summary,
    transaction_date: meta.transaction_date,
    location: meta.location,
    payment_method: meta.payment_method,
  }
}

/** Build expense notes from bill meta (summary + merchant context). */
function buildExpenseNotes(meta: BillExtractionMeta): string | null {
  const parts: string[] = []
  if (meta.merchant) parts.push(`Bill: ${meta.merchant}`)
  if (meta.raw_bill_summary) parts.push(meta.raw_bill_summary)
  const s = parts.join(' — ').slice(0, 8000)
  return s || null
}

/** Pick the best date from extraction meta + items (first non-null wins). */
function resolveExtractionDate(meta: BillExtractionMeta, items: { billing_month: string; spent_on: string | null }[]): string {
  if (meta.transaction_date) return meta.transaction_date
  for (const item of items) {
    if (item.spent_on) return item.spent_on
  }
  if (items.length > 0) return items[0].billing_month
  return new Date().toISOString().slice(0, 10)
}

// ── POST /from-bill — scan receipt image and persist results ─────────────────

/** Must be declared before GET /:id */
costRouter.post(
  '/from-bill',
  uploadBillMiddleware,
  async (req, res) => {
    if (!req.file?.buffer?.length) {
      res.status(400).json({
        error:
          'Image file missing. Send multipart/form-data field **image** or **file** (JPEG / PNG / WebP / GIF / HEIC). In Swagger: Authorize first, expand request body **image** _Choose File_, then Execute.',
      })
      return
    }

    const sb = res.locals.sbAuthClient
    const userCats = await fetchUserCostCategories(sb)

    let extracted
    try {
      extracted = await extractCostsFromBillImage({
        buffer: req.file.buffer,
        mimeType: normalizedBillImageDataUrlMime(
          req.file.mimetype,
          req.file.originalname ?? '',
          req.file.buffer,
        ),
        userCategories: userCats,
      })
    } catch (e) {
      const status =
        typeof e === 'object' &&
        e !== null &&
        'statusCode' in e &&
        typeof (e as { statusCode?: unknown }).statusCode === 'number'
          ? (e as { statusCode: number }).statusCode
          : 502
      const msg = e instanceof Error ? e.message : 'Bill scan failed'
      res.status(status).json({ error: msg })
      return
    }

    const { items, meta } = extracted

    if (items.length === 0) {
      res.status(422).json({
        error:
          'Could not extract priced line items from this image. Try a clearer photo.',
        extraction: extractionErrorPayload(meta),
      })
      return
    }

    let resolved
    try {
      resolved = await resolveCategoryIdsForItems(
        sb,
        res.locals.authUser.id,
        items,
      )
    } catch (e) {
      const status =
        typeof e === 'object' &&
        e !== null &&
        'statusCode' in e &&
        typeof (e as { statusCode?: unknown }).statusCode === 'number'
          ? (e as { statusCode: number }).statusCode
          : 503
      const msg =
        e instanceof Error ? e.message : 'Could not resolve expense categories'
      res.status(status).json({
        error: msg,
        extraction: extractionErrorPayload(meta),
      })
      return
    }

    const expenseDate = resolveExtractionDate(meta, resolved)

    const result = await createExpenseWithCosts({
      sb,
      userId: res.locals.authUser.id,
      expense: {
        date: expenseDate,
        name: (meta.merchant ?? '').slice(0, 500),
        location: (meta.location ?? '').slice(0, 500),
        notes: buildExpenseNotes(meta),
        payment_method: parsePaymentMethod(meta.payment_method),
        is_draft: true,
        confidence_score: meta.confidence_score ?? null,
      },
      costs: resolved.map((it) => ({
        name: it.name.slice(0, 500),
        category_id: it.category_id!,
        qty: it.qty,
        amount: it.amount,
        currency: it.currency.slice(0, 12),
      })),
    })

    if (result.ok === false) {
      res.status(result.status).json({
        error: result.message,
        extraction: extractionErrorPayload(meta),
      })
      return
    }

    res.status(201).json({
      expense: shapeExpenseForApi({
        ...result.expense,
        costs: result.costs,
        charges: result.charges,
      }),
      extraction: extractionResponsePayload(meta, items.length),
    })
  },
)

// ── POST /from-text — extract costs from natural language ─────────────────────

costRouter.post('/from-text', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  if (!text) {
    res.status(400).json({
      error: 'text is required (non-empty string in JSON body)',
    })
    return
  }
  if (text.length > 12_000) {
    res.status(400).json({ error: 'text must be at most 12000 characters' })
    return
  }

  const defaultMonthParam = normalizeBillingMonthInput(req.body?.billing_month)
  const defaultCurrency =
    typeof req.body?.default_currency === 'string'
      ? req.body.default_currency.trim()
      : null

  const sb = res.locals.sbAuthClient
  const userCats = await fetchUserCostCategories(sb)

  let extracted
  try {
    extracted = await extractCostsFromNaturalLanguage({
      text,
      defaultBillingMonth: defaultMonthParam,
      defaultCurrency: defaultCurrency?.length ? defaultCurrency : null,
      userCategories: userCats,
    })
  } catch (e) {
    const status =
      typeof e === 'object' &&
      e !== null &&
      'statusCode' in e &&
      typeof (e as { statusCode?: unknown }).statusCode === 'number'
        ? (e as { statusCode: number }).statusCode
        : 502
    const msg = e instanceof Error ? e.message : 'Text extraction failed'
    res.status(status).json({ error: msg })
    return
  }

  const { items, meta } = extracted

  if (items.length === 0) {
    res.status(422).json({
      error:
        'Could not derive any expenses with amounts from this text. Include amounts and what they were for.',
      extraction: extractionErrorPayload(meta),
    })
    return
  }

  let resolved
  try {
    resolved = await resolveCategoryIdsForItems(
      sb,
      res.locals.authUser.id,
      items,
    )
  } catch (e) {
    const status =
      typeof e === 'object' &&
      e !== null &&
      'statusCode' in e &&
      typeof (e as { statusCode?: unknown }).statusCode === 'number'
        ? (e as { statusCode: number }).statusCode
        : 503
    const msg =
      e instanceof Error ? e.message : 'Could not resolve expense categories'
    res.status(status).json({
      error: msg,
      extraction: extractionErrorPayload(meta),
    })
    return
  }

  const expenseDate = resolveExtractionDate(meta, resolved)

  const result = await createExpenseWithCosts({
    sb,
    userId: res.locals.authUser.id,
    expense: {
      date: expenseDate,
      name: (meta.merchant ?? '').slice(0, 500),
      location: (meta.location ?? '').slice(0, 500),
      notes: buildExpenseNotes(meta),
      payment_method: parsePaymentMethod(meta.payment_method),
      is_draft: true,
      confidence_score: meta.confidence_score ?? null,
    },
    costs: resolved.map((it) => ({
      name: it.name.slice(0, 500),
      category_id: it.category_id!,
      qty: it.qty,
      amount: it.amount,
      currency: it.currency.slice(0, 12),
    })),
  })

  if (result.ok === false) {
    res.status(result.status).json({
      error: result.message,
      extraction: extractionErrorPayload(meta),
    })
    return
  }

  res.status(201).json({
    expense: shapeExpenseForApi({
      ...result.expense,
      costs: result.costs,
      charges: result.charges,
    }),
    extraction: extractionResponsePayload(meta, items.length),
  })
})

// ── GET /summary/daily — rolling daily spending totals ───────────────────────

costRouter.get('/summary/daily', requireAuth, async (req, res) => {
  const sb = res.locals.sbAuthClient

  const rawDays = req.query.days
  const days = Math.min(
    90,
    Math.max(1, Number.isFinite(Number(rawDays)) ? Math.floor(Number(rawDays)) : 7),
  )
  const currency =
    typeof req.query.currency === 'string' ? req.query.currency.toUpperCase() : null

  const now = new Date()
  const fromDateStr = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  )
    .toISOString()
    .slice(0, 10)
  const toDateStr = now.toISOString().slice(0, 10)

  const includeDrafts = req.query.include_drafts === 'true'

  // Exclude draft expenses from totals by default unless ?include_drafts=true
  let query = sb
    .from(EXPENSE_TABLE)
    .select('date, costs(amount, currency)')
    .gte('date', fromDateStr)
    .lte('date', toDateStr)
    .order('date', { ascending: true })

  if (!includeDrafts) {
    query = query.eq('is_draft', false)
  }

  const { data, error } = await query

  if (error) {
    res.status(502).json({ error: error.message })
    return
  }

  const byDay = new Map<string, Map<string, number>>()

  // Pre-populate every day with zero so gaps appear in output
  for (let i = 0; i < days; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1) + i),
    )
    byDay.set(d.toISOString().slice(0, 10), new Map())
  }

  for (const expRow of data ?? []) {
    const dateKey = expRow.date as string
    const costs = Array.isArray(expRow.costs) ? expRow.costs : []
    for (const cost of costs) {
      const cur =
        typeof cost.currency === 'string' ? cost.currency.toUpperCase() : 'USD'
      if (currency && cur !== currency) continue
      const amt = typeof cost.amount === 'number' ? cost.amount : 0
      const dayMap = byDay.get(dateKey)
      if (!dayMap) continue
      dayMap.set(cur, (dayMap.get(cur) ?? 0) + amt)
    }
  }

  const allCurrencies = new Set<string>()
  for (const dayMap of byDay.values()) {
    for (const cur of dayMap.keys()) allCurrencies.add(cur)
  }

  const isSingleCurrency = allCurrencies.size <= 1 || currency !== null
  const resolvedCurrency =
    currency ?? (allCurrencies.size === 1 ? [...allCurrencies][0] : null)

  const points = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayMap]) => {
      if (isSingleCurrency) {
        const cur = resolvedCurrency ?? [...dayMap.keys()][0] ?? 'MIXED'
        return { date, total: dayMap.get(cur) ?? 0, currency: cur }
      }
      return {
        date,
        total: [...dayMap.values()].reduce((s, v) => s + v, 0),
        currency: 'MIXED',
        breakdown: Object.fromEntries(dayMap),
      }
    })

  res.json({ points, from: fromDateStr, to: toDateStr, days })
})

// ── GET /categories — list user's cost categories ────────────────────────────

const CATEGORY_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

costRouter.get('/categories', async (_req, res) => {
  const categories = await fetchUserCostCategories(res.locals.sbAuthClient)
  res.json({ categories })
})

// ── PATCH /categories/:categoryId ────────────────────────────────────────────

costRouter.patch('/categories/:categoryId', async (req, res) => {
  const categoryId =
    typeof req.params.categoryId === 'string' ? req.params.categoryId.trim() : ''
  if (!categoryId || !CATEGORY_ID_RE.test(categoryId)) {
    res.status(400).json({ error: 'invalid category id' })
    return
  }

  const body = req.body as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'JSON body expected' })
    return
  }

  const patch: Record<string, unknown> = {}
  if ('emoji' in body) {
    if (typeof body.emoji !== 'string') {
      res.status(400).json({ error: 'emoji must be a string' })
      return
    }
    patch.emoji = body.emoji.trim().slice(0, 32)
  }
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name must be non-empty text' })
      return
    }
    patch.name = body.name.trim().slice(0, 200)
  }
  if ('color' in body) {
    if (body.color !== null && typeof body.color !== 'string') {
      res.status(400).json({ error: 'color must be string or null' })
      return
    }
    const c = parseCategoryColor(
      body.color === null ? '' : (body.color as string),
    )
    if (c === null) {
      res.status(400).json({
        error:
          'color must be empty or a hex string like #RGB, #RRGGBB, or #RRGGBBAA',
      })
      return
    }
    patch.color = c
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({
      error: 'no recognized fields (emoji, name, color)',
    })
    return
  }

  const { data, error } = await res.locals.sbAuthClient
    .from('cost_categories')
    .update(patch as never)
    .eq('id', categoryId)
    .select('id, emoji, name, is_generated_by_ai, color')
    .maybeSingle()

  if (error) {
    res.status(400).json({ error: error.message })
    return
  }

  if (!data) {
    res.status(404).json({ error: 'not found' })
    return
  }

  res.json({ category: data })
})

// ── GET / — list costs (with expense + category) ─────────────────────────────

costRouter.get('/', async (req, res) => {
  const sb = res.locals.sbAuthClient

  let query = sb
    .from(COST_TABLE)
    .select(COST_SELECT)
    .order('created_at', { ascending: false })

  const monthFilter =
    typeof req.query.month === 'string'
      ? normalizeBillingMonthInput(req.query.month)
      : null

  if (monthFilter) {
    const endExclusive = nextMonthFirstIso(monthFilter)
    // Filter by the parent expense date via the PostgREST embedded resource filter.
    // !inner ensures costs without a matching expense in range are excluded.
    query = (
      sb
        .from(COST_TABLE)
        .select(
          '*, cost_categories(id, emoji, name, is_generated_by_ai, color), expenses!inner(id, date, name, location, payment_method, notes, confidence_score, is_draft)',
        )
        .filter('expenses.date', 'gte', monthFilter)
        .filter('expenses.date', 'lt', endExclusive)
        .order('created_at', { ascending: false })
    )
  }

  const { data, error } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({
    costs: shapeCostsForApi((data ?? []) as Record<string, unknown>[]),
  })
})

// ── GET /:id — single cost ───────────────────────────────────────────────────

costRouter.get('/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : ''
  if (!id) {
    res.status(400).json({ error: 'missing id' })
    return
  }
  if (id === 'from-bill' || id === 'from-text' || id === 'summary') {
    res.status(404).json({ error: 'not found' })
    return
  }

  const { data, error } = await res.locals.sbAuthClient
    .from(COST_TABLE)
    .select(COST_SELECT)
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

  res.json({
    cost: shapeCostForApi(data as Record<string, unknown>),
  })
})

// ── POST / — create one expense + one cost line (compatibility shim) ─────────

costRouter.post('/', async (req, res) => {
  const sb = res.locals.sbAuthClient

  const lineName = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const amountRaw = req.body?.amount
  const amount =
    typeof amountRaw === 'number'
      ? amountRaw
      : typeof amountRaw === 'string'
        ? Number(amountRaw)
        : NaN
  const currency =
    typeof req.body?.currency === 'string' ? req.body.currency.trim() : 'USD'

  const categoryIdRaw = req.body?.category_id
  const categoryId =
    typeof categoryIdRaw === 'string' ? categoryIdRaw.trim() : ''

  // Accept `date` (new) or `spent_on` / `billing_month` (legacy)
  const dateInput = req.body?.date ?? req.body?.spent_on ?? req.body?.transaction_date
  const dateFromInput = normalizeSpentOnInput(dateInput)
  const dateFromMonth = normalizeBillingMonthInput(req.body?.billing_month)
  const resolvedDate = dateFromInput ?? dateFromMonth

  if (!lineName || !resolvedDate) {
    res.status(400).json({
      error: 'name and date (YYYY-MM-DD) or billing_month (YYYY-MM) are required',
    })
    return
  }

  if (!categoryId || !COST_CATEGORY_UUID_RE.test(categoryId)) {
    res.status(400).json({
      error: 'category_id is required (must be a valid UUID from cost_categories)',
    })
    return
  }

  const categoryExists = await fetchCostCategoryNameById(sb, categoryId)
  if (!categoryExists) {
    res.status(400).json({
      error: 'category_id must reference one of your cost_categories',
    })
    return
  }

  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({ error: 'amount must be a non-negative number' })
    return
  }

  const qtyRaw = req.body?.qty
  const qty =
    qtyRaw !== undefined
      ? typeof qtyRaw === 'number'
        ? qtyRaw
        : typeof qtyRaw === 'string'
          ? Number(qtyRaw)
          : NaN
      : 1
  if (!Number.isFinite(qty) || qty <= 0) {
    res.status(400).json({ error: 'qty must be a positive number' })
    return
  }

  const expenseName =
    typeof req.body?.expense_name === 'string'
      ? req.body.expense_name.trim().slice(0, 500)
      : ''
  const location =
    typeof req.body?.location === 'string'
      ? req.body.location.trim().slice(0, 500)
      : ''
  const notesRaw = req.body?.notes
  const notes =
    typeof notesRaw === 'string' && notesRaw.trim()
      ? notesRaw.trim().slice(0, 8000)
      : null
  const paymentMethod = parsePaymentMethod(
    typeof req.body?.payment_method === 'string' ? req.body.payment_method : null,
  )

  const result = await createExpenseWithCosts({
    sb,
    userId: res.locals.authUser.id,
    expense: {
      date: resolvedDate,
      name: expenseName || lineName,
      location,
      notes,
      payment_method: paymentMethod,
    },
    costs: [{ name: lineName, category_id: categoryId, amount, currency, qty }],
  })

  if (result.ok === false) {
    res.status(result.status).json({ error: result.message })
    return
  }

  const cost = result.costs[0]
  res.status(201).json({
    cost: shapeCostForApi(cost as Record<string, unknown>),
    expense: result.expense,
  })
})

// ── PATCH /:id — update cost line fields ─────────────────────────────────────

costRouter.patch('/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : ''
  if (!id) {
    res.status(400).json({ error: 'missing id' })
    return
  }
  if (id === 'from-bill' || id === 'from-text' || id === 'summary') {
    res.status(404).json({ error: 'not found' })
    return
  }

  const patch: Record<string, unknown> = {}
  const body = req.body as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'JSON body expected' })
    return
  }

  const sb = res.locals.sbAuthClient

  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name must be non-empty text' })
      return
    }
    patch.name = body.name.trim()
  }
  if ('category_id' in body) {
    if (typeof body.category_id !== 'string' || !body.category_id.trim()) {
      res.status(400).json({ error: 'category_id must be a non-empty uuid string' })
      return
    }
    const cid = body.category_id.trim()
    if (!COST_CATEGORY_UUID_RE.test(cid)) {
      res.status(400).json({ error: 'category_id must be a valid UUID' })
      return
    }
    const categoryName = await fetchCostCategoryNameById(sb, cid)
    if (!categoryName) {
      res.status(400).json({
        error: 'category_id must reference one of your cost_categories',
      })
      return
    }
    patch.category_id = cid
  }
  if ('amount' in body) {
    const n =
      typeof body.amount === 'number'
        ? body.amount
        : typeof body.amount === 'string'
          ? Number(body.amount)
          : NaN
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: 'amount must be a non-negative number' })
      return
    }
    patch.amount = n
  }
  if ('currency' in body) {
    if (typeof body.currency !== 'string' || !body.currency.trim()) {
      res.status(400).json({ error: 'currency must be non-empty text' })
      return
    }
    patch.currency = body.currency.trim()
  }
  if ('qty' in body) {
    const n =
      typeof body.qty === 'number'
        ? body.qty
        : typeof body.qty === 'string'
          ? Number(body.qty)
          : NaN
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ error: 'qty must be a positive number' })
      return
    }
    patch.qty = n
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({
      error:
        'no recognized fields (name, category_id, amount, currency, qty). To update date, notes, location, or payment_method, PATCH /api/expenses/:id',
    })
    return
  }

  patch.updated_at = new Date().toISOString()

  const { data, error } = await sb
    .from(COST_TABLE)
    .update(patch as never)
    .eq('id', id)
    .select(COST_SELECT)
    .maybeSingle()

  if (error) {
    res.status(400).json({ error: error.message })
    return
  }

  if (!data) {
    res.status(404).json({ error: 'not found' })
    return
  }

  res.json({
    cost: shapeCostForApi(data as Record<string, unknown>),
  })
})

// ── DELETE /:id — delete single cost line ────────────────────────────────────

costRouter.delete('/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : ''
  if (!id) {
    res.status(400).json({ error: 'missing id' })
    return
  }
  if (id === 'from-bill' || id === 'from-text' || id === 'summary') {
    res.status(404).json({ error: 'not found' })
    return
  }

  const { data, error } = await res.locals.sbAuthClient
    .from(COST_TABLE)
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
