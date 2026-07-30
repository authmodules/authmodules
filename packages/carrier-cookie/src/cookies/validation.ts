export function isCookiePath(value?: unknown): boolean {
  return typeof value === 'string'
    && value.length <= 2048
    && /^\/[\x20-\x3A\x3C-\x7E]*$/.test(value)
}

export function isCookieDomain(value?: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253 || /[\r\n;\s]/.test(value)) return false
  const normalized = value.startsWith('.') ? value.slice(1) : value
  if (normalized.length === 0) return false
  return normalized.split('.').every((label: string): boolean => (
    label.length > 0 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ))
}
