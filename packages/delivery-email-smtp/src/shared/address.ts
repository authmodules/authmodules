import { isSafeText } from './json.ts'

export function isSafeAddress(value: unknown): value is string {
  return isSafeText(value, 2048)
    && value.length > 0
    && !/[,;]/.test(value)
}
