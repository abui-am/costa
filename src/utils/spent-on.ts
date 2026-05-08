/**
 * Calendar transaction date for receipts (not normalized to month start).
 * Accepts `YYYY-MM-DD` prefix or ISO string; optional `YYYY-MM` → that month’s 1st day.
 */
export function normalizeSpentOnInput(value: unknown): string | null {
  if (value == null) {
    return null
  }
  if (typeof value !== 'string') {
    return null
  }
  const s = value.trim().slice(0, 40)
  if (!s.length) {
    return null
  }

  const ym = /^(\d{4})-(\d{2})$/.exec(s)
  if (ym) {
    const y = Number(ym[1])
    const mo = Number(ym[2])
    if (!Number.isInteger(y) || mo < 1 || mo > 12) {
      return null
    }
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-01`
  }

  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!ymd) {
    return null
  }
  const y = Number(ymd[1])
  const mo = Number(ymd[2])
  const day = Number(ymd[3])
  if (!Number.isInteger(y) || mo < 1 || mo > 12 || day < 1 || day > 31) {
    return null
  }
  const d = new Date(Date.UTC(y, mo - 1, day))
  if (
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() !== mo - 1 ||
    d.getUTCDate() !== day
  ) {
    return null
  }
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
