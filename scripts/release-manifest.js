export const packageRepositories = Object.freeze([
  'contracts',
  'core',
  'testkit',
  'method-password',
  'method-otp',
  'store-postgres',
  'crypto-node',
  'token-opaque',
  'carrier-cookie',
  'delivery-email-smtp',
  'effects-sync-delivery',
  'framework-express',
  'effects-outbox',
  'outbox-worker',
  'guard-memory'
])

const numericIdentifier = '(?:0|[1-9][0-9]*)'
const nonNumericIdentifier = '(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`
const exactVersion = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}`
  + `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?`
  + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$'
)
const exactIntegrity = /^sha512-[0-9A-Za-z+/]{85}[AQgw]==$/

export function isExactVersion(value) {
  return typeof value === 'string' && exactVersion.test(value)
}

export function isExactIntegrity(value) {
  return typeof value === 'string' && exactIntegrity.test(value)
}
