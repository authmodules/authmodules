import type { TenantId } from '@authmodules/contracts/primitives'

export function outboxSecretPurpose(tenantId: TenantId, messageId: string): string
export function outboxSecretPurpose(tenantId: TenantId, messageId: string): string {
  if (typeof tenantId !== 'string' || tenantId.length === 0 || typeof messageId !== 'string' || messageId.length === 0) {
    throw new TypeError('Outbox secret purpose identifiers are required')
  }
  return JSON.stringify(['authmodules.outbox.delivery', tenantId, messageId])
}
