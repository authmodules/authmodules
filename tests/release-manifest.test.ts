import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isExactIntegrity,
  isExactVersion,
  packageRepositories,
  parseReleaseManifest,
  publishedIntegrities,
  publishedVersions,
  workflowOutputs
} from '../scripts/release-manifest.js'

const integrity = `sha512-${'A'.repeat(86)}==`

function validManifest() {
  return {
    schemaVersion: 2,
    release: '0.1.0',
    packages: Object.fromEntries(packageRepositories.map((repository, index) => [
      repository,
      {
        repository: `authmodules/${repository}`,
        revision: (index + 1).toString(16).padStart(40, '0'),
        tag: 'v0.1.0',
        version: '0.1.0',
        integrity
      }
    ]))
  }
}

test('release manifest freezes every repository, tag, revision, version, and package digest', () => {
  const manifest = parseReleaseManifest(validManifest(), '0.1.0')

  assert.deepEqual(publishedVersions(manifest), Object.fromEntries(
    packageRepositories.map((repository) => [repository, '0.1.0'])
  ))
  assert.deepEqual(publishedIntegrities(manifest), Object.fromEntries(
    packageRepositories.map((repository) => [repository, integrity])
  ))
  assert.equal(workflowOutputs(manifest).method_password_ref, 'refs/tags/v0.1.0')
  assert.equal(workflowOutputs(manifest).published_versions.includes('"contracts":"0.1.0"'), true)
  assert.equal(workflowOutputs(manifest).published_integrities.includes(`"contracts":"${integrity}"`), true)
})

test('release manifest rejects missing packages and mutable source references', () => {
  const missing = validManifest()
  delete missing.packages['guard-memory']
  assert.throws(
    () => parseReleaseManifest(missing, '0.1.0'),
    /release manifest packages keys must be exactly/
  )

  const branchRef = validManifest()
  branchRef.packages.core.revision = 'main'
  assert.throws(
    () => parseReleaseManifest(branchRef, '0.1.0'),
    /core revision must be a full lowercase commit SHA/
  )

  const malformedIntegrity = validManifest()
  malformedIntegrity.packages.core.integrity = 'sha512-not-a-digest'
  assert.throws(
    () => parseReleaseManifest(malformedIntegrity, '0.1.0'),
    /core integrity must be an exact SHA-512 digest/
  )
})

test('release manifest rejects mismatched repository, tag, and release identity', () => {
  const wrongRepository = validManifest()
  wrongRepository.packages.core.repository = 'someone/core'
  assert.throws(
    () => parseReleaseManifest(wrongRepository, '0.1.0'),
    /core repository must be authmodules\/core/
  )

  const wrongTag = validManifest()
  wrongTag.packages.core.tag = 'latest'
  assert.throws(
    () => parseReleaseManifest(wrongTag, '0.1.0'),
    /core tag must match its package version/
  )

  assert.throws(
    () => parseReleaseManifest(validManifest(), '0.2.0'),
    /release manifest must describe 0.2.0/
  )
})

test('exact versions follow SemVer identifier and leading-zero rules', () => {
  for (const version of [
    '0.1.0',
    '1.2.3-alpha.1',
    '1.2.3-0',
    '1.2.3+build.01',
    '1.2.3-alpha+build.5'
  ]) {
    assert.equal(isExactVersion(version), true, version)
  }

  for (const version of [
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-.',
    '1.2.3-alpha.',
    '1.2.3+',
    '1.2',
    '^1.2.3'
  ]) {
    assert.equal(isExactVersion(version), false, version)
  }
})

test('package integrities require one canonical SHA-512 SRI digest', () => {
  assert.equal(isExactIntegrity(integrity), true)
  assert.equal(isExactIntegrity(`sha256-${'A'.repeat(43)}=`), false)
  assert.equal(isExactIntegrity(`sha512-${'A'.repeat(85)}==`), false)
  assert.equal(isExactIntegrity(`sha512-${'A'.repeat(86)}=`), false)
  assert.equal(isExactIntegrity(`${integrity} ${integrity}`), false)
})
