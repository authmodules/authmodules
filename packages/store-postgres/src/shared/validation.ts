export function isSafeStoredText(value: unknown, maxLength: number, requireNonEmpty: boolean): value is string {
  return typeof value === 'string'
    && (!requireNonEmpty || value.length > 0)
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

export function isValidDate(value: unknown): value is Date {
  try {
    if (!(value instanceof Date)) return false
    return Number.isFinite(Date.prototype.getTime.call(value))
  } catch {
    return false
  }
}

export function isStoredOptionalDate(value: unknown): value is string | undefined {
  return value === undefined
    || (typeof value === 'string' && value.length > 0 && Number.isFinite(new Date(value).getTime()))
}

export function isFailureResult(value: unknown): value is { readonly ok: false; readonly error: unknown } {
  return isRecord(value) && value.ok === false && 'error' in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
