export function safeHeaderName(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
    throw new TypeError('HTTP header name is invalid')
  }
  return value
}

export function safeHeaderValue(value: unknown): string {
  if (!isSafeHeaderValue(value)) {
    throw new TypeError('HTTP header value is invalid')
  }
  return value
}

export function isSafeHeaderValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 8192
    && !/[^\t\x20-\x7e\x80-\xff]/.test(value)
}
