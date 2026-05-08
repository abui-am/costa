import { createRequire } from 'node:module'
import OpenAI from 'openai'
import { mimeFromMagicBytes } from '../utils/bill-upload-mime.js'
import { normalizeBillingMonthInput } from '../utils/billing-month.js'
import { normalizeSpentOnInput } from '../utils/spent-on.js'
import type { CostCategoryRow } from './category-rag.js'
import { retrieveRelevantCategories } from './category-rag.js'
import {
  OPENAI_COST_JSON_OUTPUT_RULES,
  OPENAI_COST_NOTES_LANGUAGE_COT,
  OPENAI_COST_RAG_CATEGORY_COT,
  OPENAI_COST_WHO_PAID_COT,
  buildOpenAiCostJsonOutputSchema,
  openAiRetrievedCategoriesPromptBlock,
} from './cost-openai-output-schema.js'

const require = createRequire(import.meta.url)
const heicToJpeg = require('heic-convert') as (opts: {
  buffer: Buffer
  format: 'JPEG'
  quality?: number
}) => Promise<Uint8Array>

const VISION_MODEL = 'gpt-4o-mini'

export type ParsedBillCost = {
  name: string
  /** Denormalized display name for DB `category` text column */
  category: string
  /** FK to cost_categories when RAG matched */
  category_id: string | null
  /**
   * When `category_id` is null, suggested emoji for a new `cost_categories` row
   * (single emoji or short string).
   */
  new_category_emoji: string | null
  /**
   * When creating a new `cost_categories` row, optional UI color (`#RGB` / `#RRGGBB` / `#RRGGBBAA`).
   */
  new_category_color: string | null
  /** Purchase quantity for the line (e.g. 3 coffees); defaults to 1. */
  qty: number
  amount: number
  currency: string
  billing_month: string
  notes: string | null
  /** Receipt / transaction calendar date (`YYYY-MM-DD`) when known */
  spent_on: string | null
  location: string
  payment_method: string
}

export type BillExtractionMeta = {
  merchant: string | null
  raw_bill_summary: string | null
  /** Mirrors model `transaction_date`; same meaning as persisted `spent_on`. */
  transaction_date: string | null
  location: string | null
  payment_method: string | null
  /** Model-estimated overall extraction confidence in [0,1]; null when not returned. */
  confidence_score: number | null
}

function buildBillVisionSystemPrompt(ragJsonBlock: string): string {
  const schema = buildOpenAiCostJsonOutputSchema()
  return `You are a precise receipt and invoice reader. Analyze the attached bill/receipt image.

Work through this reasoning **internally** (do not echo these steps as plain prose in JSON). Then output **JSON only** matching the schema below (no markdown fences).

**Chain of thought (internal steps)**

1) **Read text and normalize money**
   - Transcribe amounts as they appear, then convert to a single number in **major currency units** (not cents).
   - **Indonesian / European-style thousands:** a dot between digit groups is thousands, not a decimal. Examples: \`35.000\` → **35000**; \`225.000\` → **225000**; \`1.234.567\` → **1234567**.
   - US-style \`1,234.56\` → 1234.56. If both styles appear, prefer the print format on the receipt.

2) **Line items vs roll-up rows**
   - Prefer **individual priced lines** (products, fees, tax lines, transfer amounts) when visible.
   - **Do not** add a separate \`items\` row whose role is only the **grand / final total** (e.g. labels like "Total", "Grand Total", "Jumlah Bayar", "Total Transaksi", "Total Pembayaran", "Subtotal") **when you already list the underlying lines that sum to it** — that would double-count. If the image only shows one amount with a total-like label, include **one** item for that amount (describe it clearly in \`name\`).

3)
${OPENAI_COST_RAG_CATEGORY_COT}

${ragJsonBlock}

4) **Currency, transaction context, and shape of output**
   - If you see **Rp**, **IDR**, or Indonesian number formatting, set \`currency\` to **IDR**; otherwise use the symbol or text on the receipt (ISO 4217).
   - At the **root** of JSON: fill **\`transaction_date\`** (\`YYYY-MM-DD\`), **\`location\`** (city / outlet / address), and **\`payment_method\`** whenever they appear on the receipt (infer ISO date from Indonesian day-month-year text when clear).
   - For bank transfer / payment slips with a single clear amount, one row is enough; if no retrieved category fits, set \`category_id\` null and \`category_name_fallback\` to **Transfer** when appropriate.

5)
${OPENAI_COST_WHO_PAID_COT}

6)
${OPENAI_COST_NOTES_LANGUAGE_COT}

${schema}

${OPENAI_COST_JSON_OUTPUT_RULES}
`
}

async function decodeBillImageIfHeic(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  let visionBuffer = buffer
  let visionMimeHint = mimeType
  const baseMime = visionMimeHint.trim().toLowerCase().split(';')[0].trim()
  const sniffed = mimeFromMagicBytes(buffer)
  const isHeifClass =
    baseMime === 'image/heic' ||
    baseMime === 'image/heif' ||
    baseMime === 'image/heif-sequence' ||
    sniffed === 'image/heic' ||
    sniffed === 'image/heif'

  if (isHeifClass) {
    try {
      const out = await heicToJpeg({
        buffer,
        format: 'JPEG',
        quality: 0.92,
      })
      visionBuffer = Buffer.from(out)
      visionMimeHint = 'image/jpeg'
    } catch {
      throw Object.assign(
        new Error(
          'Could not decode HEIC/HEIF. The file may be corrupt or use an unsupported variant; try exporting as JPEG.',
        ),
        { statusCode: 400 },
      )
    }
  }
  return { buffer: visionBuffer, mimeType: visionMimeHint }
}

async function summarizeBillForCategoryRag(prepared: {
  buffer: Buffer
  mimeType: string
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey?.trim()) {
    return ''
  }
  const openai = new OpenAI({ apiKey })
  const b64 = prepared.buffer.toString('base64')
  const mime = sanitizeMime(prepared.mimeType)
  const completion = await openai.chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Output JSON only: {"retrieval_text": string}. One English line, max 35 words: merchant, venue type, main products/services, currency hint — for embedding search of user expense categories.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this receipt for category retrieval.' },
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${b64}` },
          },
        ],
      },
    ],
  })
  const raw = completion.choices[0]?.message?.content?.trim() ?? ''
  if (!raw) {
    return ''
  }
  try {
    const p = parseJsonLoose(raw) as Record<string, unknown>
    const t =
      typeof p.retrieval_text === 'string' ? p.retrieval_text.trim() : ''
    return t.slice(0, 500)
  } catch {
    return ''
  }
}

export async function extractCostsFromBillImage(
  params: Readonly<{
    buffer: Buffer
    mimeType: string
    userCategories?: ReadonlyArray<CostCategoryRow>
  }>,
): Promise<{
  items: ParsedBillCost[]
  meta: BillExtractionMeta
}> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey?.trim()) {
    throw Object.assign(new Error('OPENAI_API_KEY is not set'), {
      statusCode: 503,
    })
  }

  const userCats = params.userCategories ?? []
  const openai = new OpenAI({ apiKey })
  const prepared = await decodeBillImageIfHeic(params.buffer, params.mimeType)
  const ragText = await summarizeBillForCategoryRag(prepared)
  const retrieved = await retrieveRelevantCategories(userCats, ragText, 12)
  const ragBlock = openAiRetrievedCategoriesPromptBlock(retrieved)
  const systemPrompt = buildBillVisionSystemPrompt(ragBlock)

  const b64 = prepared.buffer.toString('base64')
  const mime = sanitizeMime(prepared.mimeType)

  const completion = await openai.chat.completions.create({
    model: VISION_MODEL,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Follow your reasoning chain internally (IDR dotted amounts → whole rupiah; omit rollup total rows when line items already cover them). Assign category_id from RETRIEVED_CATEGORIES only. Produce JSON matching the schema.',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mime};base64,${b64}`,
            },
          },
        ],
      },
    ],
  })

  const raw =
    completion.choices[0]?.message?.content?.trim() ?? ''
  if (!raw) {
    throw Object.assign(new Error('No response text from vision model'), {
      statusCode: 502,
    })
  }

  return parseOpenAiCostResponse(raw, {
    defaultBillingMonth: null,
    retrievedCategories: retrieved,
  })
}

function sanitizeMime(mime: string): string {
  const allowed = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ]
  const m = mime.trim().toLowerCase()
  return allowed.includes(m) ? m : 'image/jpeg'
}

function parseJsonLoose(raw: string): unknown {
  let s = raw.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  }
  return JSON.parse(s)
}

/** Default first day of current UTC month */
function fallbackBillingMonth(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth() + 1
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-01`
}

/** Parse model JSON (bill or natural-language extraction) into rows + summary meta. */
export function parseOpenAiCostResponse(
  raw: string,
  options?: Readonly<{
    defaultBillingMonth?: string | null
    retrievedCategories?: ReadonlyArray<CostCategoryRow>
  }>,
): { items: ParsedBillCost[]; meta: BillExtractionMeta } {
  let parsed: unknown
  try {
    parsed = parseJsonLoose(raw)
  } catch {
    throw Object.assign(new Error('Model returned invalid JSON'), {
      statusCode: 502,
    })
  }
  return {
    items: normalizeParsedCosts(
      parsed,
      options?.defaultBillingMonth ?? null,
      options?.retrievedCategories ?? [],
    ),
    meta: extractionMeta(parsed),
  }
}

function extractionMeta(parsed: unknown): BillExtractionMeta {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      merchant: null,
      raw_bill_summary: null,
      transaction_date: null,
      location: null,
      payment_method: null,
      confidence_score: null,
    }
  }
  const o = parsed as Record<string, unknown>
  const merchant =
    typeof o.merchant === 'string'
      ? o.merchant.trim() || null
      : typeof o.merchant === 'number'
        ? String(o.merchant)
        : null
  const summary =
    typeof o.notes === 'string'
      ? o.notes.trim() || null
      : typeof o.summary === 'string'
        ? o.summary.trim() || null
        : null
  const txn = parseTransactionFieldsFromParsedRoot(o)
  const rawConf = o.confidence_score
  const confidence_score =
    typeof rawConf === 'number' && Number.isFinite(rawConf)
      ? Math.min(1, Math.max(0, rawConf))
      : null
  return {
    merchant,
    raw_bill_summary: summary,
    transaction_date: txn.spent_on,
    location: txn.location || null,
    payment_method: txn.payment_method || null,
    confidence_score,
  }
}

function parseTransactionFieldsFromParsedRoot(
  o: Record<string, unknown>,
): {
  spent_on: string | null
  location: string
  payment_method: string
} {
  const spent_on = normalizeSpentOnInput(o.transaction_date ?? o.spent_on)
  const location =
    typeof o.location === 'string' ? o.location.trim().slice(0, 500) : ''
  const payment_method =
    typeof o.payment_method === 'string'
      ? o.payment_method.trim().slice(0, 200)
      : ''
  return { spent_on, location, payment_method }
}

function mergeLineTransactionText(
  rowVal: unknown,
  docFallback: string,
  maxLen: number,
): string {
  if (typeof rowVal === 'string' && rowVal.trim()) {
    return rowVal.trim().slice(0, maxLen)
  }
  return docFallback.slice(0, maxLen)
}

/** Parse model output: IDR style 35.000 → 35000; strips Rp/IDR prefix from strings. */
function parseMajorCurrencyAmount(amountRaw: unknown): number {
  if (typeof amountRaw === 'number' && Number.isFinite(amountRaw)) {
    return Math.max(0, amountRaw)
  }
  if (typeof amountRaw !== 'string') {
    return NaN
  }
  let s = amountRaw.trim().replace(/\u00a0/g, '').replace(/\u202f/g, '')
  if (!s.length) {
    return NaN
  }
  s = s.replace(/^Rp\.?\s*/iu, '').replace(/^IDR\s*/iu, '').trim()

  // Indonesian dot-as-thousands: 35.000 or 1.234.567 (optionally ,xx fractional — rare)
  const idThousands =
    /^(\d{1,3}(?:\.\d{3})+)(,\d{1,4})?$/.exec(s)
  if (idThousands) {
    const wholeDigits = idThousands[1]!.replace(/\./g, '')
    if (idThousands[2]) {
      const frac = idThousands[2].slice(1)
      const n = Number(`${wholeDigits}.${frac}`)
      return Number.isFinite(n) ? Math.max(0, n) : NaN
    }
    const n = Number(wholeDigits)
    return Number.isFinite(n) ? Math.max(0, n) : NaN
  }

  // US/international: 1,234.56
  if (/^\d{1,3}(,\d{3})*\.\d+$/.test(s)) {
    const n = Number(s.replace(/,/g, ''))
    return Number.isFinite(n) ? Math.max(0, n) : NaN
  }

  // Thousands-only commas: 35,000
  if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    const n = Number(s.replace(/,/g, ''))
    return Number.isFinite(n) ? Math.max(0, n) : NaN
  }

  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? Math.max(0, n) : NaN
}

/** Labels that duplicate line sums — dropped only when multiple rows exist. */
function excludedGrandTotalLabel(raw: string): boolean {
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!t.length || t.length > 120) {
    return false
  }
  return (
    /^(grand\s+)?total$/u.test(t) ||
    /^total\s+(bayar|pembayaran|transaksi|tagihan)$/u.test(t) ||
    /^total\s+harga$/u.test(t) ||
    /^jumlah(\s+(bayar|tagihan|pembayaran))?$/u.test(t) ||
    /^subtotal$/u.test(t)
  )
}

function stripExcludedTotals(rows: ParsedBillCost[]): ParsedBillCost[] {
  if (rows.length <= 1) {
    return rows
  }
  return rows.filter((r) => !excludedGrandTotalLabel(r.name))
}

function normalizeParsedCosts(
  parsed: unknown,
  defaultBillingMonthInput: string | null,
  retrievedCategories: ReadonlyArray<CostCategoryRow>,
): ParsedBillCost[] {
  const allowedIds = new Set(
    retrievedCategories.map((c) => c.id.trim().toLowerCase()),
  )
  const idToRow = new Map(
    retrievedCategories.map((c) => [c.id.trim().toLowerCase(), c]),
  )

  const override =
    defaultBillingMonthInput != null
      ? normalizeBillingMonthInput(defaultBillingMonthInput)
      : null
  const defaultMonth = override ?? fallbackBillingMonth()
  const docTxn =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parseTransactionFieldsFromParsedRoot(parsed as Record<string, unknown>)
      : { spent_on: null as string | null, location: '', payment_method: '' }
  const box = unwrapItems(parsed)

  const out: ParsedBillCost[] = []
  let idx = 0
  for (const row of box) {
    idx += 1
    const nameRaw =
      typeof row.name === 'string'
        ? row.name.trim()
        : typeof row.description === 'string'
          ? row.description.trim()
          : ''
    const name =
      nameRaw ||
      (typeof row.label === 'string' && row.label.trim()) ||
      `Line ${idx}`

    let categoryId: string | null = null
    let categoryName = 'Unknown'
    const cidRaw = row.category_id
    const cidNorm =
      typeof cidRaw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        cidRaw.trim(),
      )
        ? cidRaw.trim().toLowerCase()
        : null

    let newEmoji: string | null = null
    let newColor: string | null = null

    if (cidNorm && allowedIds.has(cidNorm)) {
      categoryId = cidNorm
      const cr = idToRow.get(cidNorm)
      categoryName = cr?.name?.trim() || 'Unknown'
    } else {
      const fb =
        typeof row.category_name_fallback === 'string'
          ? row.category_name_fallback.trim()
          : typeof row.category === 'string'
            ? row.category.trim()
            : ''
      categoryName = (fb || 'Unknown').slice(0, 200)
      const neRaw = row.new_category_emoji
      if (typeof neRaw === 'string' && neRaw.trim()) {
        newEmoji = neRaw.trim().slice(0, 32)
      }
      const ncRaw = row.new_category_color
      if (typeof ncRaw === 'string' && ncRaw.trim()) {
        const t = ncRaw.trim().slice(0, 32)
        if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) {
          newColor = t.toLowerCase()
        }
      }
    }

    const amt = parseMajorCurrencyAmount(row.amount)
    if (!Number.isFinite(amt)) {
      continue
    }
    const currency =
      typeof row.currency === 'string' && row.currency.trim()
        ? row.currency.trim().toUpperCase()
        : 'USD'
    let billingMonth: string = defaultMonth
    if (row.billing_month != null) {
      const n =
        typeof row.billing_month === 'string'
          ? normalizeBillingMonthInput(row.billing_month)
          : normalizeBillingMonthInput(String(row.billing_month))
      if (n) {
        billingMonth = n
      }
    }
    const notesVal = row.notes
    let notesMerged: string | null = null
    if (notesVal !== null && notesVal !== undefined) {
      if (typeof notesVal === 'string' && notesVal.trim()) {
        notesMerged = notesVal.trim().slice(0, 4000)
      }
    }

    const rowSpent = normalizeSpentOnInput(row.transaction_date ?? row.spent_on)
    const spent_on = rowSpent ?? docTxn.spent_on
    const location = mergeLineTransactionText(
      row.location,
      docTxn.location,
      500,
    )
    const payment_method = mergeLineTransactionText(
      row.payment_method,
      docTxn.payment_method,
      200,
    )

    const qtyRaw = row.qty
    const qtyParsed =
      typeof qtyRaw === 'number' && Number.isFinite(qtyRaw) && qtyRaw > 0
        ? qtyRaw
        : typeof qtyRaw === 'string'
          ? (() => { const n = Number(qtyRaw); return Number.isFinite(n) && n > 0 ? n : 1 })()
          : 1

    out.push({
      name: name.slice(0, 500),
      category: categoryName,
      category_id: categoryId,
      new_category_emoji: newEmoji,
      new_category_color: newColor,
      qty: qtyParsed,
      amount: amt,
      currency: currency.slice(0, 12),
      billing_month: billingMonth,
      notes: notesMerged,
      spent_on,
      location,
      payment_method,
    })
  }

  return stripExcludedTotals(out)
}

function unwrapItems(parsed: unknown): Record<string, unknown>[] {
  if (!parsed || typeof parsed !== 'object') {
    return []
  }
  const obj = parsed as Record<string, unknown>
  let arr = obj.items
  if (!Array.isArray(arr) && Array.isArray(obj.line_items)) {
    arr = obj.line_items
  }
  if (!Array.isArray(arr)) {
    return []
  }
  return arr.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
}
