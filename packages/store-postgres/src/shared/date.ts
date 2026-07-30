export function date(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('PostgreSQL returned an invalid timestamp')
  }
  const parsed = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp')
  return parsed
}
