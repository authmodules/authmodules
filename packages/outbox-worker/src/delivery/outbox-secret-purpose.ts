export function outboxSecretPurpose(tenantId: string, messageId: string): string {
  if (tenantId.length === 0 || messageId.length === 0) {
    throw new TypeError('Outbox secret purpose identifiers are required')
  }
  return JSON.stringify(['authmodules.outbox.delivery', tenantId, messageId])
}
