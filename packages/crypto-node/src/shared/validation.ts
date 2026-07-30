export function isSafeIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

export function isValidDate(value: unknown): value is Date {
  return dateTimestamp(value) !== undefined
}

export function validOptionalDate(value: unknown): value is Date | undefined {
  return value === undefined || isValidDate(value)
}

export function dateTimestamp(value: unknown): number | undefined {
  if (!(value instanceof Date)) return undefined
  try {
    const timestamp = Date.prototype.getTime.call(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  } catch {
    return undefined
  }
}

export function assertByteLength(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_048_576) {
    throw new TypeError('Byte length must be an integer from 1 to 1048576.')
  }
}
