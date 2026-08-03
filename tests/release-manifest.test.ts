import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  assertReleasePleaseManifest,
  isExactIntegrity,
  isExactVersion,
  packageRepositories
} from '../scripts/release-manifest.js'

const root = path.resolve(import.meta.dirname, '..')
const integrity = `sha512-${'A'.repeat(86)}==`

test('workspaces and Release Please describe the same package set', async () => {
  const rootManifest = await readJson('package.json')
  const releaseConfig = await readJson('release-please-config.json')
  const releaseManifest = await readJson('.release-please-manifest.json')
  const expectedPaths = packageRepositories.map((name) => `packages/${name}`)

  assert.deepEqual(rootManifest.workspaces, expectedPaths)
  assert.deepEqual(Object.keys(releaseConfig.packages), expectedPaths)
  assert.doesNotThrow(() => assertReleasePleaseManifest(releaseManifest))
  assert.equal(releaseConfig['release-type'], 'node')
  assert.equal(releaseConfig['separate-pull-requests'], false)
  assert.equal(releaseConfig['always-link-local'], false)
  assert.equal(releaseConfig['include-component-in-tag'], true)
  assert.equal(releaseConfig['include-v-in-tag'], true)
  assert.deepEqual(releaseConfig.plugins, [{
    type: 'node-workspace',
    updatePeerDependencies: true
  }])
})

test('release automation has one direct path without lifecycle state', async () => {
  const checkWorkflow = await readText('.github/workflows/check.yml')
  const releasePullRequestWorkflow = await readText('.github/workflows/release-pr.yml')
  const publishWorkflow = await readText('.github/workflows/release-publish.yml')
  const consumerScript = await readText('scripts/check-packed-consumer.js')
  const componentReleaseScript = await readText('scripts/create-component-releases.js')
  const createPullRequestScript = await readText('scripts/create-release-pr.js')
  const combined = [
    releasePullRequestWorkflow,
    publishWorkflow,
    createPullRequestScript
  ].join('\n')

  assert.match(releasePullRequestWorkflow, /on:\n  workflow_dispatch:\n/)
  assert.match(releasePullRequestWorkflow, /node scripts\/create-release-pr\.js/)
  assert.match(releasePullRequestWorkflow, /gh workflow run check\.yml/)
  assert.match(releasePullRequestWorkflow, /Reject conflicting release pull requests/)
  assert.match(releasePullRequestWorkflow, /--paginate/)
  assert.match(releasePullRequestWorkflow, /\.head\.repo\.full_name != \$repository/)
  assert.match(
    releasePullRequestWorkflow,
    /head=\$\{GITHUB_REPOSITORY_OWNER\}:release-please--branches--main/
  )
  assert.match(releasePullRequestWorkflow, /ref: \$\{\{ steps\.release_pr\.outputs\.head_sha \}\}/)
  assert.doesNotMatch(releasePullRequestWorkflow, /issues: write/)
  assert.match(createPullRequestScript, /skipLabeling: true/)
  assert.match(checkWorkflow, /ref: \$\{\{ inputs\.head_sha \|\| github\.sha \}\}/)
  assert.match(
    checkWorkflow,
    /test "\$GITHUB_SHA" = "\$AUTHMODULES_EXPECTED_HEAD_SHA"/
  )
  assert.match(
    checkWorkflow,
    /Check monorepo[\s\S]*AUTHMODULES_PR_TITLE: \$\{\{ github\.event\.pull_request\.title \|\| inputs\.pr_title \}\}/
  )
  assert.ok(
    checkWorkflow.indexOf('Verify dispatched head')
      < checkWorkflow.indexOf('Checkout monorepo')
  )
  assert.match(publishWorkflow, /paths:\n      - \.release-please-manifest\.json/)
  assert.doesNotMatch(publishWorkflow, /\n  workflow_dispatch:/)
  assert.match(publishWorkflow, /Verify Release Please merge/)
  assert.match(publishWorkflow, /release-please--branches--main/)
  assert.match(publishWorkflow, /\.title == "chore: release main"/)
  assert.match(publishWorkflow, /run: npm run check/)
  assert.match(publishWorkflow, /node scripts\/create-release-plan\.js/)
  assert.match(publishWorkflow, /npm publish/)
  assert.match(
    publishWorkflow,
    /Attest build provenance[\s\S]*subject-path:[\s\S]*Attest SBOM/
  )
  assert.doesNotMatch(publishWorkflow, /predicate-path|predicate-type/)
  assert.match(publishWorkflow, /AUTHMODULES_PUBLISHED: 'true'/)
  assert.match(publishWorkflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
  assert.match(consumerScript, /metadata\.visibility !== 'public'/)
  assert.match(consumerScript, /metadata\.repository\?\.full_name !== expectedRepository/)
  assert.match(consumerScript, /attempts: 6, delayMilliseconds: 5_000/)
  assert.match(publishWorkflow, /node scripts\/create-component-releases\.js/)
  assert.match(publishWorkflow, /AUTHMODULES_RELEASE_MATRIX:/)
  assert.match(publishWorkflow, /AUTHMODULES_RELEASE_SHA: \$\{\{ github\.sha \}\}/)
  assert.doesNotMatch(publishWorkflow, /gh release create|Preflight component Releases/)
  assert.match(componentReleaseScript, /make_latest: 'false'/)
  assert.match(componentReleaseScript, /const expected = await Promise\.all/)
  assert.match(componentReleaseScript, /const verified = await Promise\.all/)
  assert.doesNotMatch(combined, /autorelease:|repair|release state/i)
})

test('workspace manifests keep independent package identities', async () => {
  const contractsManifest = await readJson('packages/contracts/package.json')
  for (const name of packageRepositories) {
    const packagePath = `packages/${name}`
    const manifest = await readJson(`${packagePath}/package.json`)
    assert.equal(manifest.name, `@authmodules/${name}`)
    assert.equal(isExactVersion(manifest.version), true)
    assert.equal(manifest.repository.url, 'git+https://github.com/authmodules/authmodules.git')
    assert.equal(manifest.repository.directory, packagePath)
    assert.equal(manifest.publishConfig.registry, 'https://npm.pkg.github.com')
    if (name !== 'contracts') {
      assert.equal(
        manifest.peerDependencies['@authmodules/contracts'],
        `^${contractsManifest.version}`
      )
    }
  }
})

test('release values require exact SemVer and SHA-512 integrity', () => {
  for (const version of [
    '0.1.0',
    '1.2.3-alpha.1',
    '1.2.3-0',
    '1.2.3+build.01'
  ]) {
    assert.equal(isExactVersion(version), true, version)
  }
  for (const version of ['01.2.3', '1.2.03', '1.2.3-01', '1.2', '^1.2.3']) {
    assert.equal(isExactVersion(version), false, version)
  }

  assert.equal(isExactIntegrity(integrity), true)
  assert.equal(isExactIntegrity(`sha256-${'A'.repeat(43)}=`), false)
  assert.equal(isExactIntegrity(`${integrity} ${integrity}`), false)
})

test('release manifest contains every workspace exactly once', () => {
  const complete = Object.fromEntries(
    packageRepositories.map((name) => [`packages/${name}`, '0.1.0'])
  )

  assert.doesNotThrow(() => assertReleasePleaseManifest(complete))
  assert.throws(() => assertReleasePleaseManifest({}), /missing:/)
  assert.throws(
    () => assertReleasePleaseManifest({ ...complete, 'packages/unknown': '0.1.0' }),
    /unknown: packages\/unknown/
  )
  assert.throws(
    () => assertReleasePleaseManifest({ ...complete, 'packages/contracts': '^0.1.0' }),
    /invalid version for packages\/contracts/
  )
})

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath))
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}
