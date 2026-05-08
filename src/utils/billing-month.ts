/**
 * Accept `YYYY-MM` or `YYYY-MM-DD` (any day in month → normalized first day).
 * Returns normalized `YYYY-MM-01` as date string or null if invalid.
 */
export function normalizeBillingMonthInput(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const s = value.trim()

  const ym = /^(\d{4})-(\d{1,2})$/.exec(s)
  if (ym) {
    const y = Number(ym[1])
    const mo = Number(ym[2])
    if (!Number.isInteger(y) || mo < 1 || mo > 12) {
      return null
    }
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-01`
  }

  const ymd =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s) ?? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (ymd) {
    const y = Number(ymd[1])
    const mo = Number(ymd[2])
    if (
      !Number.isInteger(y) ||
      mo < 1 ||
      mo > 12 ||
      Number(ymd[3]) < 1 ||
      Number(ymd[3]) > 31
    ) {
      return null
    }
    const d =
      /^(\d{4})-(\d{2})-(\d{2})/.test(s)
        ? new Date(`${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}T12:00:00Z`)
        : null
    if (!d || Number.isNaN(d.valueOf())) {
      return null
    }
    const month = String(d.getUTCMonth() + 1).padStart(2, '0')
    return `${d.getUTCFullYear()}-${month}-01`
  }

  return null
}

/** Exclusive upper bound ISO date for `billing_month >= start and < exclusiveEnd` filtering */
export function nextMonthFirstIso(startIsoYYYY_MM_DD: string): string {
  const [yStr, mStr] = startIsoYYYY_MM_DD.split('-')
  const y = Number(yStr)
  const mo = Number(mStr)
  const dt = new Date(Date.UTC(y, mo - 1 + 1, 1))
  return dt.toISOString().slice(0, 10)
}
