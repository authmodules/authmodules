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
  { allowEmpty = false, label = 'Release Please manifest' } = {}
) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`)
  }

  const expectedPaths = packageRepositories.map((name) => `packages/${name}`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new Error(`${label} must contain only string package paths`)
  }
  const actualPaths = ownKeys
  for (const packagePath of actualPaths) {
    const descriptor = descriptors[packagePath]
    if (
      !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new Error(`${label} must contain only enumerable data properties`)
    }
  }
  if (allowEmpty && actualPaths.length === 0) return

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
    if (!isExactVersion(descriptors[packagePath].value)) {
      throw new Error(`${label} has an invalid version for ${packagePath}`)
    }
  }
}

export function shouldPublishReleaseManifest(previousManifest, currentManifest) {
  assertReleasePleaseManifest(previousManifest, {
    allowEmpty: true,
    label: 'Previous release manifest'
  })
  assertReleasePleaseManifest(currentManifest, {
    allowEmpty: true,
    label: 'Current release manifest'
  })

  const previousIsEmpty = Reflect.ownKeys(previousManifest).length === 0
  const currentIsEmpty = Reflect.ownKeys(currentManifest).length === 0
  if (currentIsEmpty && !previousIsEmpty) {
    throw new Error('A complete release manifest cannot transition back to bootstrap state')
  }
  return !currentIsEmpty
}
