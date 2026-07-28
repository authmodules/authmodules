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
const exactRevision = /^[0-9a-f]{40}$/
const exactIntegrity = /^sha512-[0-9A-Za-z+/]{85}[AQgw]==$/

export function isExactVersion(value) {
  return typeof value === 'string' && exactVersion.test(value)
}

export function isExactIntegrity(value) {
  return typeof value === 'string' && exactIntegrity.test(value)
}

export function parseReleaseManifest(value, expectedRelease) {
  assertPlainObject(value, 'release manifest')
  assertExactKeys(value, ['schemaVersion', 'release', 'packages'], 'release manifest')
  assert(value.schemaVersion === 2, 'release manifest schemaVersion must be 2')
  assert(isExactVersion(value.release), 'release manifest release must be an exact version')
  if (expectedRelease !== undefined) {
    assert(value.release === expectedRelease, `release manifest must describe ${expectedRelease}`)
  }

  assertPlainObject(value.packages, 'release manifest packages')
  assertExactKeys(value.packages, packageRepositories, 'release manifest packages')

  const packages = {}
  for (const repository of packageRepositories) {
    const entry = value.packages[repository]
    assertPlainObject(entry, `${repository} release entry`)
    assertExactKeys(entry, ['repository', 'revision', 'tag', 'version', 'integrity'], `${repository} release entry`)
    assert(entry.repository === `authmodules/${repository}`, `${repository} repository must be authmodules/${repository}`)
    assert(
      typeof entry.revision === 'string'
        && exactRevision.test(entry.revision)
        && !/^0{40}$/.test(entry.revision),
      `${repository} revision must be a full lowercase commit SHA`
    )
    assert(isExactVersion(entry.version), `${repository} version must be exact`)
    assert(entry.tag === `v${entry.version}`, `${repository} tag must match its package version`)
    assert(isExactIntegrity(entry.integrity), `${repository} integrity must be an exact SHA-512 digest`)
    packages[repository] = Object.freeze({ ...entry })
  }

  return Object.freeze({
    schemaVersion: 2,
    release: value.release,
    packages: Object.freeze(packages)
  })
}

export function publishedVersions(manifest) {
  return Object.fromEntries(packageRepositories.map((repository) => [
    repository,
    manifest.packages[repository].version
  ]))
}

export function publishedIntegrities(manifest) {
  return Object.fromEntries(packageRepositories.map((repository) => [
    repository,
    manifest.packages[repository].integrity
  ]))
}

export function workflowOutputs(manifest) {
  const outputs = {
    published_versions: JSON.stringify(publishedVersions(manifest)),
    published_integrities: JSON.stringify(publishedIntegrities(manifest))
  }
  for (const repository of packageRepositories) {
    outputs[`${repository.replaceAll('-', '_')}_ref`] = `refs/tags/${manifest.packages[repository].tag}`
  }
  return outputs
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value)
  assert(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} keys must be exactly: ${expected.join(', ')}`
  )
}

function assertPlainObject(value, label) {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
