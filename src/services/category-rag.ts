import OpenAI from 'openai'

export type CostCategoryRow = {
  id: string
  emoji: string
  name: string
  color: string
  is_generated_by_ai?: boolean
}

const EMBED_MODEL = 'text-embedding-3-small'
/** Below this, skip embeddings and return the full list (still capped). */
const RAG_EMBED_THRESHOLD = 24
const RAG_TOP_K = 12
const MAX_QUERY_CHARS = 8000

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

function categoryEmbedLine(c: CostCategoryRow): string {
  const e = c.emoji?.trim() ?? ''
  const col = c.color?.trim() ?? ''
  const n = c.name.trim()
  const parts = [
    e ? `${e} ` : '',
    col ? `${col} ` : '',
    n,
  ]
  return parts.join('').trim() || n
}

/**
 * Embedding-based retrieval of user categories for expense classification (RAG).
 */
export async function retrieveRelevantCategories(
  all: readonly CostCategoryRow[],
  query: string,
  topK: number = RAG_TOP_K,
): Promise<CostCategoryRow[]> {
  if (all.length === 0) {
    return []
  }

  if (all.length <= RAG_EMBED_THRESHOLD) {
    return [...all]
  }

  const q = query.trim().slice(0, MAX_QUERY_CHARS)
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey?.trim() || !q.length) {
    return [...all].slice(0, Math.min(topK, all.length))
  }

  const openai = new OpenAI({ apiKey })
  const lines = all.map(categoryEmbedLine)
  const input = [q, ...lines]

  let vectors: number[][]
  try {
    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input,
    })
    const out = res.data
      .map((d) => ({ i: d.index, v: d.embedding }))
      .sort((a, b) => a.i - b.i)
      .map((x) => x.v)
    vectors = out
  } catch {
    return [...all].slice(0, Math.min(topK, all.length))
  }

  const queryVec = vectors[0]
  if (!queryVec) {
    return [...all].slice(0, Math.min(topK, all.length))
  }

  const scored = all.map((row, idx) => {
    const vec = vectors[idx + 1]
    const score = vec ? cosine(queryVec, vec) : 0
    return { row, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.min(topK, scored.length)).map((s) => s.row)
}
