import { OpenAI } from 'openai'
import type { BillExtractionMeta, ParsedBillCost } from './bill-scan.js'
import { parseOpenAiCostResponse } from './bill-scan.js'
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

const TEXT_MODEL = 'gpt-4o-mini'

function buildTextSystemPrompt(ragJsonBlock: string): string {
  const schema = buildOpenAiCostJsonOutputSchema()
  return `You turn informal natural-language spending descriptions into structured expense line items.

Work through this reasoning **internally** (do not echo these steps as plain prose in JSON). Then output **JSON only** matching the schema below (no markdown fences).

**Chain of thought (internal steps)**

1) **Normalize the user's text**
   - Resolve vague shorthand, typos, and chat-style wording into clear conventional descriptions before extracting amounts.
   - Infer implied units (e.g. "5 bucks" → 5 USD major units; "50k" / "35 rb" → use context; **Rp** / **IDR** / Indonesian dotted thousands → IDR).

2) **Identify expenses**
   - Each distinct purchase, fee, subscription, or transfer the user mentions becomes a line item when it has a quantifiable amount.
   - If they give itemized amounts **and** a stated total for the same list, **do not** add a separate rollup row that only repeats that total (avoid double-count).

3) **Build line items**
   - **amount**, **currency**, **billing_month**: non-negative **major** units; Indonesian dotted thousands \`35.000\` → 35000; **IDR** when appropriate; \`YYYY-MM-01\` when dated.

4)
${OPENAI_COST_RAG_CATEGORY_COT}

${ragJsonBlock}

5)
${OPENAI_COST_WHO_PAID_COT}

6)
${OPENAI_COST_NOTES_LANGUAGE_COT}

7) **Output shape**
   - \`merchant\`: payee or store name if given, else null.
   - Per-item fields follow the shared schema below. Assign \`category_id\` only from **RETRIEVED_CATEGORIES**.

${schema}

${OPENAI_COST_JSON_OUTPUT_RULES}
`
}

export async function extractCostsFromNaturalLanguage(
  params: Readonly<{
    text: string
    defaultBillingMonth?: string | null
    defaultCurrency?: string | null
    userCategories?: ReadonlyArray<CostCategoryRow>
  }>,
): Promise<{ items: ParsedBillCost[]; meta: BillExtractionMeta }> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey?.trim()) {
    throw Object.assign(new Error('OPENAI_API_KEY is not set'), {
      statusCode: 503,
    })
  }

  const userCats = params.userCategories ?? []
  const retrieved = await retrieveRelevantCategories(userCats, params.text, 12)
  const ragBlock = openAiRetrievedCategoriesPromptBlock(retrieved)
  const systemPrompt = buildTextSystemPrompt(ragBlock)

  const openai = new OpenAI({ apiKey })

  const hintParts: string[] = []
  const dc = params.defaultCurrency?.trim()
  if (dc) {
    hintParts.push(
      `When currency is unstated, prefer ISO 4217 code ${dc.toUpperCase()}.`,
    )
  }
  const userBlock = [hintParts.join(' '), '', `User message:\n${params.text}`]
    .filter(Boolean)
    .join('\n')

  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userBlock },
    ],
  })

  const raw = completion.choices[0]?.message?.content?.trim() ?? ''
  if (!raw) {
    throw Object.assign(new Error('No response text from model'), {
      statusCode: 502,
    })
  }

  return parseOpenAiCostResponse(raw, {
    defaultBillingMonth: params.defaultBillingMonth ?? null,
    retrievedCategories: retrieved,
  })
}
