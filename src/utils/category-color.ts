/** Accept `#RGB`, `#RRGGBB`, `#RRGGBBAA`, or blank. Returns `null` if non-empty but invalid. */
export function parseCategoryColor(
  raw: string | null | undefined,
): string | null {
  const s = (raw ?? '').trim().slice(0, 32)
  if (!s) {
    return ''
  }
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) {
    return s.toLowerCase()
  }
  return null
}
