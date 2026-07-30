import type { CreateAuthConfig } from '@authmodules/contracts/core'
import type { CoreIdKind, TenantId } from '@authmodules/contracts/primitives'
import { isNonEmptyString } from '../validation/input.ts'

export function generateCoreId(
  config: CreateAuthConfig,
  kind: CoreIdKind,
  tenantId: TenantId,
  now: Date
): string | undefined {
  try {
    const timestamp = Date.prototype.getTime.call(now)
    if (!Number.isFinite(timestamp)) return undefined
    const value = config.idGenerator.generate({
      kind,
      tenantId,
      now: new Date(timestamp)
    })
    return isNonEmptyString(value) ? value : undefined
  } catch {
    return undefined
  }
}
