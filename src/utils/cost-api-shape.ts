/** Shape a `costs` DB row (with optional embedded joins) into the API representation. */
export function shapeCostForApi(row: Record<string, unknown>): Record<string, unknown> {
  const cc = row.cost_categories
  let category: {
    id: string | null
    emoji: string
    name: string
    color: string
    is_generated_by_ai: boolean
  }

  if (
    cc &&
    typeof cc === 'object' &&
    !Array.isArray(cc) &&
    typeof (cc as { id?: unknown }).id === 'string'
  ) {
    const o = cc as {
      id: string
      emoji?: string
      name?: string
      color?: string
      is_generated_by_ai?: boolean
    }
    category = {
      id: o.id,
      emoji: typeof o.emoji === 'string' ? o.emoji : '',
      name: typeof o.name === 'string' ? o.name : '',
      color: typeof o.color === 'string' ? o.color : '',
      is_generated_by_ai: o.is_generated_by_ai === true,
    }
  } else {
    category = {
      id: typeof row.category_id === 'string' ? row.category_id : null,
      emoji: '',
      color: '',
      name: '',
      is_generated_by_ai: false,
    }
  }

  const exp = row.expenses
  const expense =
    exp && typeof exp === 'object' && !Array.isArray(exp)
      ? (exp as Record<string, unknown>)
      : null

  const { cost_categories: _cc, expenses: _exp, ...rest } = row
  return { ...rest, category, expense }
}

export function shapeCostsForApi(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map(shapeCostForApi)
}

/** Shape a raw `expenses` row (with optional embedded `costs` and `expense_charges` arrays) for the API. */
export function shapeExpenseForApi(row: Record<string, unknown>): Record<string, unknown> {
  const costs = Array.isArray(row.costs)
    ? (row.costs as Record<string, unknown>[]).map(shapeCostForApi)
    : undefined

  const charges = Array.isArray(row.expense_charges)
    ? (row.expense_charges as Record<string, unknown>[])
    : undefined

  const { costs: _costs, expense_charges: _ec, ...rest } = row
  return {
    ...rest,
    ...(costs !== undefined ? { costs } : {}),
    ...(charges !== undefined ? { charges } : {}),
  }
}

export function shapeExpensesForApi(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map(shapeExpenseForApi)
}
