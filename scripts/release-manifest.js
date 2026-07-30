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

export function assertReleasePleaseManifest(
  value,
  { label = 'Release Please manifest' } = {}
) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object`)
  }

  const expectedPaths = packageRepositories.map((name) => `packages/${name}`)
  const actualPaths = Object.keys(value)
  const expected = new Set(expectedPaths)
  const missing = expectedPaths.filter((packagePath) => !Object.hasOwn(value, packagePath))
  const unknown = actualPaths.filter((packagePath) => !expected.has(packagePath))
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} must contain exactly all package paths`
      + `${missing.length === 0 ? '' : `; missing: ${missing.join(', ')}`}`
      + `${unknown.length === 0 ? '' : `; unknown: ${unknown.join(', ')}`}`
    )
  }

  for (const packagePath of expectedPaths) {
    if (!isExactVersion(value[packagePath])) {
      throw new Error(`${label} has an invalid version for ${packagePath}`)
    }
  }
}
