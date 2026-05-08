/**
 * OpenAI bill + text extraction: shared CoT blocks and JSON schema.
 * Category assignment uses RAG-ranked RETRIEVED_CATEGORIES (see category-rag.ts).
 * Kept in sync with parseOpenAiCostResponse / normalizeParsedCosts in bill-scan.ts.
 */

import type { CostCategoryRow } from './category-rag.js'

export const OPENAI_COST_RAG_CATEGORY_COT = `**RAG categories (retrieve-then-assign)**
- **RETRIEVED_CATEGORIES** (JSON below) is the user's category library, **ranked for relevance** to this expense. Before you finalize each line item, choose its **\`category_id\`** from **only** that list: copy an \`id\` **exactly** when one row is a reasonable match. **Never invent UUIDs.**
- If **no** retrieved row fits, set \`category_id\` to **null**, set \`category_name_fallback\` to **exactly one** English label from: Groceries, Dining, Utilities, Transport, Subscription, Household, Taxes, Fees, Healthcare, Electronics, Clothing, Shopping, Income, Transfer, Tip, Fuel, Telecom, Housing, Parking, Misc, Unknown — and set **\`new_category_emoji\`** to **one fitting emoji** (or a short emoji phrase) for that label so the backend can create a user category marked as AI-generated.
- Optional: set **\`new_category_color\`** to one CSS-style **hex** tint for that category: \`#RGB\`, \`#RRGGBB\`, or \`#RRGGBBAA\` (e.g. \`#2d7ef7\`); use \`null\` if unsure.
- When **RETRIEVED_CATEGORIES** is \`[]\`, use \`category_id\` **null**, pick \`category_name_fallback\`, and always provide \`new_category_emoji\`.`

export function openAiRetrievedCategoriesPromptBlock(
  retrieved: ReadonlyArray<CostCategoryRow>,
): string {
  const payload = retrieved.map((c) => ({
    id: c.id,
    emoji: c.emoji ?? '',
    color: (c.color ?? '').trim(),
    name: c.name,
    is_generated_by_ai: c.is_generated_by_ai === true,
  }))
  return `**RETRIEVED_CATEGORIES** (JSON — RAG-ranked; \`category_id\` must be one of these \`id\` values or null):\n${JSON.stringify(payload)}`
}

/** Item + document shape the model returns (category via RAG id or fallback label). */
export function buildOpenAiCostJsonOutputSchema(): string {
  return `**Output schema (JSON only):**
{
  "merchant": string | null,
  "transaction_date": string | null — \`YYYY-MM-DD\` when receipt purchase date is readable; otherwise null,
  "location": string | null — city / outlet / address on receipt when visible; otherwise null,
  "payment_method": string | null — e.g. Cash, Credit Card, Debit, QRIS, E-money when stated; otherwise null,
  "confidence_score": number | null — overall extraction confidence in [0,1] (1 = very confident, 0 = very uncertain). Set lower when OCR quality is poor, amounts conflict, dates are missing, or category matches are weak. Omit or null if not applicable,
  "items": [
    {
      "name": string,
      "category_id": string | null,
      "category_name_fallback": string | null,
      "new_category_emoji": string | null,
      "new_category_color": string | null — optional \`#RGB\` / \`#RRGGBB\` / \`#RRGGBBAA\` for a new category row; null if unsure,
      "qty": number | null — purchase quantity for this line (e.g. 3 coffees, 1.5 kg); omit or 1 for single-unit items,
      "amount": number (non-negative; major units; line total regardless of qty),
      "currency": string (ISO 4217; IDR when Rp/IDR or ID formatting),
      "billing_month": string | null — "YYYY-MM-01" when the receipt/service date or user-stated date is known; otherwise null,
      "transaction_date": string | null — optional per-line override (\`YYYY-MM-DD\`) when line-specific; else omit and use root,
      "location": string | null — optional per-line override when it differs per line,
      "payment_method": string | null — optional per-line override when it differs per line,
      "notes": string | null — full bill/split context when needed (Who-paid); **same language as source** (e.g. Indonesian → Indonesian)
    }
  ],
  "notes": string | null — brief OCR/ambiguity notes for images, or short interpretation summary for text; **same language as source** (see Language for notes)
}`
}

/** Reusable CoT block: whose expense \`amount\` represents; numbering is up to the caller prompt. */
export const OPENAI_COST_WHO_PAID_COT = `**Who paid (user's actual expense)** — apply before finalizing each item's \`amount\` and \`notes\` (use cues on the receipt/image text or in the user's message):

- Detect if **someone else** covered part or all of a charge, e.g. Indonesian: *dibayarin*, *dibiayain*, *ditraktir*, *traktiran*, *patungan* / *bareng* with explicit shares; English: *paid by*, *covered by*, *they paid*, *friend treated*, *split* / *went Dutch* with stated amounts, *my share was X*.
- When **others paid** a stated portion: **\`amount\` = the tracked user's out-of-pocket only** (\`user_amount ≈ total_amount - amount_paid_by_others\` when numbers are explicit). If shares are vague, prefer the user's stated share; otherwise document uncertainty in \`notes\` and avoid overstating \`amount\`.
- **Store:** set **\`amount\`** to that **user's actual expense**, not the full bill. Put the **full original total** (and who paid what, if known) in that item's **\`notes\`** so the full context is preserved.
- **Reverse (user paid for others):** if the **user** covered the whole table/treat, **\`amount\` = the full amount the user spent**. Exception: if the text **explicitly** states only the user's own portion (e.g. *my half was 50k*), use that portion as \`amount\` and still put the full bill total in \`notes\` when given.
- If **no** split/treat/share signal applies, \`amount\` is the normal line or purchase total and \`notes\` stays optional.`

/** Reusable CoT block: locale for prose fields; numbering is up to the caller prompt. */
export const OPENAI_COST_NOTES_LANGUAGE_COT = `**Language for \`notes\`**

- Write **each item's \`notes\`** and the **root \`notes\`** in the **same language** as the source: e.g. **Indonesian** user or receipt text → **Indonesian** notes; English → English; apply the same rule for other languages.
- **\`name\`** and **\`merchant\`** may follow the source language for natural reading. **\`category_id\`**, **\`category_name_fallback\`**, **\`new_category_emoji\`**, and **\`new_category_color\`** follow the RAG section (\`category_name_fallback\` / emoji / optional color matter when \`category_id\` is null).
- Do not switch explanatory \`notes\` to English by default when the source is clearly non-English (e.g. do not translate Indonesian context in \`notes\` to English).`

export const OPENAI_COST_JSON_OUTPUT_RULES = `Rules:
- If tax is shown or mentioned as its own priced line, include it as its own item.
- Omit duplicate rows (same label + same amount repeated).
- Do not add a separate rollup total row when itemized lines already cover that sum; if only a total appears, use one item and describe it clearly in \`name\`.
- \`amount\` must be numeric in JSON — never quoted strings representing numbers.
- Omit items with no usable finite amount.
- If there is no spending with a quantifiable amount, return \`"items": []\`.
- **User's share:** \`amount\` is the tracked user's **out-of-pocket** after applying Who-paid rules; keep **full bill or pre-split totals** in \`notes\`, not in \`amount\`.
- **Notes language:** \`notes\` match the **Language for notes** section above (e.g. Indonesian in → Indonesian notes).
- **Categories:** \`category_id\` must be **null** or an \`id\` copied exactly from **RETRIEVED_CATEGORIES**. If \`category_id\` is null, set \`category_name_fallback\` **and** \`new_category_emoji\` per the RAG section (backend creates the category); \`new_category_color\` is optional hex or null.
- **Transaction context:** When source is an image receipt, populate root **\`transaction_date\`** (YYYY-MM-DD), **\`location\`**, and **\`payment_method\`** whenever legible (Indonesian or other date formats → resolve to Gregorian YYYY-MM-DD). For natural-language-only input without a concrete day, leave root fields null unless the user stated them clearly; per-line overrides are optional only when amounts differ per payment method/date.`
