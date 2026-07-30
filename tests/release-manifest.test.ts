import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  assertReleasePleaseManifest,
  isExactIntegrity,
  isExactVersion,
  packageRepositories,
  shouldPublishReleaseManifest
} from '../scripts/release-manifest.js'

const root = path.resolve(import.meta.dirname, '..')
const integrity = `sha512-${'A'.repeat(86)}==`

test('root workspaces and Release Please paths describe the complete package set', async () => {
  const rootManifest = await readJson('package.json')
  const releaseConfig = await readJson('release-please-config.json')
  const releaseManifest = await readJson('.release-please-manifest.json')
  const expectedPaths = packageRepositories.map((name) => `packages/${name}`)

  assert.deepEqual(rootManifest.workspaces, expectedPaths)
  assert.deepEqual(Object.keys(releaseConfig.packages), expectedPaths)
  assert.doesNotThrow(() => {
    assertReleasePleaseManifest(releaseManifest, { allowEmpty: true })
  })
  assert.equal(releaseConfig['release-type'], 'node')
  assert.equal(releaseConfig['initial-version'], '0.1.0')
  assert.equal(releaseConfig['separate-pull-requests'], false)
  assert.equal(releaseConfig['always-link-local'], false)
  assert.equal(releaseConfig['include-component-in-tag'], true)
  assert.equal(releaseConfig['include-v-in-tag'], true)
  assert.equal(releaseConfig['bump-minor-pre-major'], true)
  assert.equal(releaseConfig['bump-patch-for-minor-pre-major'], false)
  assert.equal(
    releaseConfig['bootstrap-sha'],
    '033300cef823e97321435ce033b0cb48772ad2e4'
  )
  assert.deepEqual(releaseConfig.plugins, [{
    type: 'node-workspace',
    updatePeerDependencies: true
  }])
})

test('release automation is manual, exact-head, and publication-gated', async () => {
  const checkWorkflow = await readText('.github/workflows/check.yml')
  const releasePullRequestWorkflow = await readText('.github/workflows/release-pr.yml')
  const publishWorkflow = await readText('.github/workflows/release-publish.yml')
  const dispatchScript = await readText('scripts/dispatch-release-pr-check.js')
  const releasePlanScript = await readText('scripts/create-release-plan.js')
  const releaseContextScript = await readText('scripts/resolve-release-publish-context.js')
  const releaseCommitScript = await readText('scripts/verify-release-commit.js')
  const releaseStateScript = await readText('scripts/resolve-github-release-state.js')
  const releaseTriggerScript = await readText('scripts/detect-release-trigger.js')
  const releaseVerificationScript = await readText('scripts/verify-release-publication.js')
  const planJob = workflowSection(publishWorkflow, 'plan', 'check')
  const publishJob = workflowSection(publishWorkflow, 'publish', 'repair')
  const repairJob = workflowSection(publishWorkflow, 'repair', 'verify')
  const verifyJob = workflowSection(publishWorkflow, 'verify', 'github-release')
  const githubReleaseJob = workflowSection(publishWorkflow, 'github-release')

  assert.match(releasePullRequestWorkflow, /on:\n  workflow_dispatch:\n/)
  assert.doesNotMatch(releasePullRequestWorkflow, /\n  push:/)
  assert.match(dispatchScript, /head_sha: pullRequest\.head\.sha/)
  assert.match(checkWorkflow, /if: inputs\.head_sha != ''/)
  assert.match(checkWorkflow, /test "\$GITHUB_SHA" = "\$AUTHMODULES_EXPECTED_HEAD_SHA"/)
  assert.match(
    publishWorkflow,
    /paths:\n      - \.release-please-manifest\.json/
  )
  assert.match(publishWorkflow, /\n  workflow_dispatch:\n/)
  assert.match(publishJob, /if: github\.event_name == 'push'/)
  assert.match(publishJob, /packages: write/)
  assert.match(publishJob, /npm publish/)
  assert.match(repairJob, /if: github\.event_name == 'workflow_dispatch'/)
  assert.match(repairJob, /packages: read/)
  assert.doesNotMatch(repairJob, /packages: write|npm publish/)
  assert.match(
    publishWorkflow,
    /pattern: release-\*-\$\{\{ needs\.plan\.outputs\.head_sha \}\}/
  )
  assert.match(
    publishWorkflow,
    /ref: \$\{\{ needs\.plan\.outputs\.head_sha \}\}/
  )
  assert.match(
    publishJob,
    /path: \.release-tooling[\s\S]*ref: \$\{\{ github\.workflow_sha \}\}/
  )
  assert.match(
    repairJob,
    /path: \.release-tooling[\s\S]*ref: \$\{\{ github\.workflow_sha \}\}/
  )
  assert.match(
    repairJob,
    /node \.release-tooling\/scripts\/prepare-package-release-evidence\.js/
  )
  assert.match(
    publishJob,
    /Verify registry package integrity[\s\S]*Attest build provenance[\s\S]*Attest SBOM/
  )
  assert.match(
    repairJob,
    /Verify existing registry package integrity[\s\S]*Attest build provenance[\s\S]*Attest SBOM/
  )
  assert.match(verifyJob, /ref: \$\{\{ needs\.plan\.outputs\.head_sha \}\}/)
  assert.match(githubReleaseJob, /ref: \$\{\{ needs\.plan\.outputs\.head_sha \}\}/)
  assert.match(
    githubReleaseJob,
    /Resolve component release state[\s\S]*Create component tags and GitHub Releases/
  )
  assert.match(
    githubReleaseJob,
    /Create component tags and GitHub Releases[\s\S]*Verify component tags and GitHub Releases/
  )
  assert.match(
    publishWorkflow,
    /AUTHMODULES_BASE_SHA: \$\{\{ needs\.plan\.outputs\.base_sha \}\}/
  )
  assert.match(
    releaseContextScript,
    /Current main release manifest differs from the requested release commit/
  )
  assert.match(
    releaseContextScript,
    /Release base must be the first parent of the release commit/
  )
  assert.match(releaseCommitScript, /autorelease: tagged/)
  assert.doesNotMatch(
    planJob,
    /Verify Release Please merge[\s\S]{0,160}working-directory: release-source/
  )
  assert.match(
    releaseStateScript,
    /Exactly one pending Release Please PR must match the release commit/
  )
  assert.match(releaseStateScript, /points to \$\{targetSha\} instead of \$\{releaseSha\}/)
  assert.match(
    releasePlanScript,
    /assertReleasePleaseManifest\(currentManifest, \{ label: 'Current release manifest' \}\)/
  )
  assert.match(
    releaseTriggerScript,
    /shouldPublishReleaseManifest\(previousManifest, manifest\)/
  )
  assert.match(releaseTriggerScript, /if \(ref === '0'\.repeat\(40\)\) return \{\}/)
  assert.match(
    publishWorkflow,
    /AUTHMODULES_PUSH_BASE_SHA: \$\{\{ github\.event\.before \}\}/
  )
  assert.match(
    releaseVerificationScript,
    /assertReleasePleaseManifest\(currentManifest, \{ label: 'Current release manifest' \}\)/
  )
  assert.ok(
    publishWorkflow.indexOf('Verify published packages and clean consumer')
      < publishWorkflow.indexOf('Create component tags and GitHub Releases')
  )
})

test('initial workspace manifests keep independent package identities at 0.1.0', async () => {
  for (const name of packageRepositories) {
    const packagePath = `packages/${name}`
    const manifest = await readJson(`${packagePath}/package.json`)
    assert.equal(manifest.name, `@authmodules/${name}`)
    assert.equal(manifest.version, '0.1.0')
    assert.equal(manifest.repository.url, 'git+https://github.com/authmodules/authmodules.git')
    assert.equal(manifest.repository.directory, packagePath)
    assert.equal(manifest.publishConfig.registry, 'https://npm.pkg.github.com')
    if (name !== 'contracts') {
      assert.equal(manifest.peerDependencies['@authmodules/contracts'], '^0.1.0')
    }
  }
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

test('release manifests are either empty bootstrap state or the complete package set', () => {
  const complete = Object.fromEntries(
    packageRepositories.map((name) => [`packages/${name}`, '0.1.0'])
  )

  assert.doesNotThrow(() => assertReleasePleaseManifest({}, { allowEmpty: true }))
  assert.doesNotThrow(() => assertReleasePleaseManifest(complete))
  assert.throws(
    () => assertReleasePleaseManifest({ 'packages/contracts': '0.1.0' }, { allowEmpty: true }),
    /missing:/
  )
  assert.throws(
    () => assertReleasePleaseManifest({ ...complete, 'packages/unknown': '0.1.0' }),
    /unknown: packages\/unknown/
  )
  assert.throws(
    () => assertReleasePleaseManifest({ ...complete, 'packages/contracts': '^0.1.0' }),
    /invalid version for packages\/contracts/
  )
  assert.throws(() => assertReleasePleaseManifest({}), /missing:/)

  assert.throws(
    () => assertReleasePleaseManifest(Object.create({ inherited: true }), { allowEmpty: true }),
    /plain data object/
  )
  const symbolManifest = Object.create(null)
  symbolManifest[Symbol('unknown')] = '0.1.0'
  assert.throws(
    () => assertReleasePleaseManifest(symbolManifest, { allowEmpty: true }),
    /only string package paths/
  )
  const nonEnumerableManifest = { ...complete }
  Object.defineProperty(nonEnumerableManifest, 'packages/unknown', {
    value: '0.1.0'
  })
  assert.throws(
    () => assertReleasePleaseManifest(nonEnumerableManifest),
    /only enumerable data properties/
  )
  let accessorReads = 0
  const accessorManifest = { ...complete }
  Object.defineProperty(accessorManifest, 'packages/contracts', {
    enumerable: true,
    get() {
      accessorReads += 1
      return '0.1.0'
    }
  })
  assert.throws(
    () => assertReleasePleaseManifest(accessorManifest),
    /only enumerable data properties/
  )
  assert.equal(accessorReads, 0)
})

test('release manifest transitions cannot return to bootstrap state', () => {
  const complete = Object.fromEntries(
    packageRepositories.map((name) => [`packages/${name}`, '0.1.0'])
  )

  assert.equal(shouldPublishReleaseManifest({}, {}), false)
  assert.equal(shouldPublishReleaseManifest({}, complete), true)
  assert.equal(shouldPublishReleaseManifest(complete, complete), true)
  assert.throws(
    () => shouldPublishReleaseManifest(complete, {}),
    /cannot transition back to bootstrap state/
  )
})

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath))
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}

function workflowSection(source, name, nextName) {
  const start = source.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `${name} job is missing`)
  const end = nextName === undefined
    ? source.length
    : source.indexOf(`\n  ${nextName}:\n`, start + 1)
  assert.notEqual(end, -1, `${nextName} job is missing after ${name}`)
  return source.slice(start, end)
}
