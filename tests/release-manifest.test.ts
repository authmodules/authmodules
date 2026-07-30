import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { isExactIntegrity, isExactVersion, packageRepositories } from '../scripts/release-manifest.js'

const root = path.resolve(import.meta.dirname, '..')
const integrity = `sha512-${'A'.repeat(86)}==`

test('root workspaces and Release Please paths describe the complete package set', async () => {
  const rootManifest = await readJson('package.json')
  const releaseConfig = await readJson('release-please-config.json')
  const releaseManifest = await readJson('.release-please-manifest.json')
  const expectedPaths = packageRepositories.map((name) => `packages/${name}`)

  assert.deepEqual(rootManifest.workspaces, expectedPaths)
  assert.deepEqual(Object.keys(releaseConfig.packages), expectedPaths)
  assert.deepEqual(releaseManifest, {})
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

  assert.match(releasePullRequestWorkflow, /on:\n  workflow_dispatch:\n/)
  assert.doesNotMatch(releasePullRequestWorkflow, /\n  push:/)
  assert.match(dispatchScript, /head_sha: pullRequest\.head\.sha/)
  assert.match(checkWorkflow, /if: inputs\.head_sha != ''/)
  assert.match(checkWorkflow, /test "\$GITHUB_SHA" = "\$AUTHMODULES_EXPECTED_HEAD_SHA"/)
  assert.match(
    publishWorkflow,
    /paths:\n      - \.release-please-manifest\.json/
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

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath))
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}
