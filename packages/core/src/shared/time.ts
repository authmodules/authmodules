import type { CreateAuthConfig } from '@authmodules/contracts/core'

export function readNow(config: CreateAuthConfig): Date | undefined {
  try {
    const value = config.clock.now()
    if (!(value instanceof Date)) return undefined
    const timestamp = Date.prototype.getTime.call(value)
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined
  } catch {
    return undefined
  }
}
