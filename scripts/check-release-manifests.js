import { access, readFile, readdir } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { isExactVersion, packageRepositories, parseReleaseManifest } from './release-manifest.js'

const repositories = packageRepositories

const workspaceRoot = new URL('../..', import.meta.url)
const expectedPackageManager = 'npm@11.16.0'
const expectedDevEngine = {
  name: 'npm',
  version: '11.16.0',
  onFail: 'error'
}
const centralManifest = await readJson(new URL('authmodules/package.json', workspaceRoot))
assert(isExactVersion(centralManifest.version), 'central package version must be an exact release identifier')
const activeRelease = parseReleaseManifest(
  await readJson(new URL(`authmodules/releases/${centralManifest.version}.json`, workspaceRoot)),
  centralManifest.version
)

for (const repository of repositories) {
  const manifest = await readJson(new URL(`${repository}/package.json`, workspaceRoot))
  const lock = await readJson(new URL(`${repository}/package-lock.json`, workspaceRoot))
  const expectedName = `@authmodules/${repository}`
  const releaseEntry = activeRelease.packages[repository]

  assert(manifest.name === expectedName, `${repository} package name must be ${expectedName}`)
  assert(manifest.version === releaseEntry.version, `${repository} package version must match the active release plan`)
  assert(
    lock.version === releaseEntry.version && lock.packages?.['']?.version === releaseEntry.version,
    `${repository} lockfile version must match the active release plan`
  )
  assertLockRootMatchesManifest(manifest, lock, repository)
  assert(manifest.private !== true, `${repository} must be publishable`)
  assert(typeof manifest.description === 'string' && manifest.description.length >= 24, `${repository} must have a useful description`)
  assert(manifest.license === 'MIT', `${repository} must declare the MIT license`)
  assert(Array.isArray(manifest.keywords) && manifest.keywords.length >= 4, `${repository} must declare at least four discovery keywords`)
  assert(manifest.repository?.url === `https://github.com/authmodules/${repository}.git`, `${repository} repository URL is invalid`)
  assert(manifest.homepage === `https://github.com/authmodules/${repository}#readme`, `${repository} homepage is invalid`)
  assert(manifest.bugs?.url === `https://github.com/authmodules/${repository}/issues`, `${repository} bugs URL is invalid`)
  assert(manifest.publishConfig?.registry === 'https://npm.pkg.github.com', `${repository} publish registry must be GitHub Packages`)
  assert(manifest.publishConfig?.access === undefined, `${repository} must not use npmjs publish access flags`)
  assert(manifest.publishConfig?.provenance === undefined, `${repository} must not use npmjs provenance flags`)
  assert(manifest.scripts?.prepack === 'npm run build', `${repository} must build during prepack`)
  assert(manifest.scripts?.['pack:dry-run'] === 'npm pack --dry-run --ignore-scripts', `${repository} dry-run pack must ignore lifecycle scripts`)
  assertToolchain(manifest, lock, repository)
  if (repository === 'contracts') {
    assert(manifest.engines === undefined, 'contracts must not impose a runtime Node.js engine')
    assert(lock.packages?.['']?.engines === undefined, 'contracts lockfile must not impose a runtime Node.js engine')
  }
  assert(!containsLocalDependency(manifest), `${repository} manifest must not contain local file/link dependencies`)
  assert(!containsLocalDependency(lock), `${repository} lockfile must not contain local file/link dependencies`)
  await access(new URL(`${repository}/README.md`, workspaceRoot))
  await access(new URL(`${repository}/LICENSE`, workspaceRoot))
  const workflowUrl = new URL(`${repository}/.github/workflows/check.yml`, workspaceRoot)
  await access(workflowUrl)
  const workflow = await readFile(workflowUrl, 'utf8')
  assertActionMajor(workflow, 'actions/checkout', 7, repository)
  assertActionMajor(workflow, 'actions/setup-node', 7, repository)
  assertCheckoutCredentialsDisabled(workflow, repository)
  assert(workflow.includes('timeout-minutes:'), `${repository} check job must have a timeout`)
  assert(
    workflow.includes('run: npm install --global npm@11.16.0'),
    `${repository} workflow must install the exact npm version`
  )
  const releaseWorkflow = await readFile(
    new URL(`${repository}/.github/workflows/release.yml`, workspaceRoot),
    'utf8'
  )
  assertActionMajor(releaseWorkflow, 'actions/checkout', 7, `${repository} release`)
  assertActionMajor(releaseWorkflow, 'actions/setup-node', 7, `${repository} release`)
  assertCheckoutCredentialsDisabled(releaseWorkflow, `${repository} release`)
  assert(releaseWorkflow.includes('workflow_dispatch:'), `${repository} release must be explicitly dispatched`)
  assert(
    releaseWorkflow.includes(`if: github.repository == 'authmodules/${repository}' && github.ref == 'refs/heads/main'`),
    `${repository} release must run only from its protected main branch`
  )
  assert(
    /^on:\n  workflow_dispatch:\n/m.test(releaseWorkflow)
      && !/^  release:\s*$/m.test(releaseWorkflow)
      && !releaseWorkflow.includes('types: [published]')
      && !releaseWorkflow.includes('github.event.release'),
    `${repository} release must not publish from a mutable GitHub Release event`
  )
  assert(releaseWorkflow.includes('release_id:'), `${repository} release must select an immutable release plan`)
  assert(
    releaseWorkflow.includes('group: publish-${{ github.repository }}-${{ inputs.release_id }}'),
    `${repository} release must serialize publication per release plan`
  )
  assert(releaseWorkflow.includes('cancel-in-progress: false'), `${repository} release must not cancel an active publication`)
  assert(releaseWorkflow.includes('timeout-minutes: 30'), `${repository} release must have a bounded timeout`)
  assert(releaseWorkflow.includes('environment: github-packages'), `${repository} release must use the protected environment`)
  assert(
    releaseWorkflow.includes('repository: authmodules/authmodules')
      && releaseWorkflow.includes('ref: refs/tags/release-plan/v${{ inputs.release_id }}'),
    `${repository} release must checkout the immutable central release plan`
  )
  assert(
    releaseWorkflow.includes('run: node scripts/resolve-package-release.js')
      && releaseWorkflow.includes(`AUTHMODULES_PACKAGE_KEY: ${repository}`)
      && releaseWorkflow.includes('AUTHMODULES_RELEASE_ID: ${{ inputs.release_id }}'),
    `${repository} release must resolve its package entry from the selected plan`
  )
  assert(
    releaseWorkflow.includes('ref: refs/tags/${{ steps.release.outputs.package_tag }}'),
    `${repository} release must checkout the planned package tag`
  )
  assert(
    releaseWorkflow.includes('run: node scripts/verify-package-release.js')
      && releaseWorkflow.includes(`AUTHMODULES_PACKAGE_DIRECTORY: ../${repository}`),
    `${repository} release must verify the exact planned source revision`
  )
  assert(releaseWorkflow.includes('packages: write'), `${repository} release must request package write permission`)
  assert(releaseWorkflow.includes('contents: read'), `${repository} release must keep source permission read-only`)
  assert(releaseWorkflow.includes('registry-url: https://npm.pkg.github.com'), `${repository} release must configure GitHub Packages`)
  assert(releaseWorkflow.includes("scope: '@authmodules'"), `${repository} release must configure the package scope`)
  assert(releaseWorkflow.includes('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), `${repository} release must use the repository token`)
  assert(!releaseWorkflow.includes('NPM_TOKEN'), `${repository} release must not require an npmjs token`)
  assert(!releaseWorkflow.includes('id-token: write'), `${repository} release must not request npmjs provenance permission`)
  assert(!releaseWorkflow.includes('--provenance'), `${repository} release must not use npmjs provenance`)
  assert(
    releaseWorkflow.includes('run: node scripts/resolve-package-publication.js')
      && releaseWorkflow.includes('AUTHMODULES_PUBLICATION_MODE: resolve')
      && releaseWorkflow.includes('AUTHMODULES_PUBLICATION_MODE: verify')
      && releaseWorkflow.match(/AUTHMODULES_EXPECTED_INTEGRITY: \$\{\{ steps\.release\.outputs\.package_integrity \}\}/g)?.length === 2,
    `${repository} release must resolve and verify immutable registry integrity`
  )
  assert(
    releaseWorkflow.includes("if: steps.publication.outputs.publish == 'true'")
      && releaseWorkflow.includes('npm publish --ignore-scripts'),
    `${repository} release must publish only when the exact version is absent`
  )

  if (repository === 'contracts') continue

  assert(
    manifest.peerDependencies?.['@authmodules/contracts'] === `^${activeRelease.packages.contracts.version}`,
    `${repository} must peer-depend on the planned contracts version`
  )
  assert(manifest.dependencies?.['@authmodules/contracts'] === undefined, `${repository} must not runtime-depend on type-only contracts`)
  assert(manifest.main === './dist/index.js', `${repository} main entrypoint is invalid`)
  assert(manifest.types === './dist/index.d.ts', `${repository} types entrypoint is invalid`)
  assert(manifest.exports?.['.']?.import === './dist/index.js', `${repository} import export is invalid`)
  assert(manifest.exports?.['.']?.types === './dist/index.d.ts', `${repository} types export is invalid`)
  assert(Array.isArray(manifest.files) && manifest.files.includes('dist') && !manifest.files.includes('src'), `${repository} publish files must contain dist and exclude src`)
  assert(
    /- name: Install package dependencies\s+run: npm ci --omit=peer --legacy-peer-deps/.test(workflow),
    `${repository} workflow must not resolve the unpublished contracts peer during package installation`
  )
  assert(
    /repository: authmodules\/contracts\s+ref: refs\/tags\/\$\{\{ steps\.release\.outputs\.contracts_tag \}\}/.test(releaseWorkflow),
    `${repository} release must verify against the contracts tag from the release plan`
  )

  const config = await readJson(new URL(`${repository}/tsconfig.json`, workspaceRoot))
  assert(config.compilerOptions?.paths?.['@authmodules/contracts']?.[0] === '../contracts/src/index.d.ts', `${repository}/tsconfig.json must resolve sibling contracts explicitly`)
}

for (const repository of ['authmodules', '.github']) {
  const workflow = await readFile(new URL(`${repository}/.github/workflows/check.yml`, workspaceRoot), 'utf8')
  assertActionMajor(workflow, 'actions/checkout', 7, repository)
  assertCheckoutCredentialsDisabled(workflow, repository)
  if (repository === 'authmodules') {
    const manifest = await readJson(new URL(`${repository}/package.json`, workspaceRoot))
    const lock = await readJson(new URL(`${repository}/package-lock.json`, workspaceRoot))
    assertLockRootMatchesManifest(manifest, lock, repository)
    assertToolchain(manifest, lock, repository)
    assertActionMajor(workflow, 'actions/setup-node', 7, repository)
    assert(
      workflow.includes('run: npm install --global npm@11.16.0'),
      `${repository} workflow must install the exact npm version`
    )
    assert(
      workflow.includes('AUTHMODULES_PUBLISHED_VERSIONS: ${{ needs.resolve_release.outputs.published_versions }}'),
      `${repository} workflow must derive post-publish versions from the committed release manifest`
    )
    assert(
      workflow.includes('AUTHMODULES_PUBLISHED_INTEGRITIES: ${{ needs.resolve_release.outputs.published_integrities }}'),
      `${repository} workflow must derive post-publish integrities from the committed release manifest`
    )
    assert(!workflow.includes('published-versions'), `${repository} workflow must not accept mutable version JSON`)
    assert(workflow.includes('release_id:'), `${repository} workflow must select a committed release manifest`)
    assert(
      workflow.includes('AUTHMODULES_RELEASE_ID: ${{ inputs.release_id }}'),
      `${repository} workflow must resolve the selected release manifest without shell interpolation`
    )
    assert(
      workflow.includes('AUTHMODULES_RELEASE_REF: ${{ github.ref }}'),
      `${repository} workflow must bind release verification to the matching immutable plan tag`
    )
    assert(
      workflow.includes('timeout-minutes: 10')
        && workflow.includes('timeout-minutes: 45')
        && workflow.includes('timeout-minutes: 30'),
      `${repository} workflow jobs must have bounded timeouts`
    )
    assert(
      /^permissions:\n  contents: read\n\njobs:/m.test(workflow),
      `${repository} workflow must keep global permissions read-only without package access`
    )
    assert(
      /published-consumer:[\s\S]*?permissions:\n      contents: read\n      packages: read/.test(workflow),
      `${repository} published consumer alone must request package read permission`
    )
    assert(
      workflow.includes('run: node scripts/check-release-workspace.js'),
      `${repository} workflow must verify checked-out tag revisions against the release manifest`
    )
    assert(
      workflow.includes('npm ci --omit=peer --legacy-peer-deps --prefix "$package"'),
      `${repository} workflow must install package tools without resolving the unpublished contracts peer`
    )
    assert(
      workflow.includes('registry-url: https://npm.pkg.github.com'),
      `${repository} published consumer must configure GitHub Packages`
    )
    assert(
      workflow.includes("scope: '@authmodules'"),
      `${repository} published consumer must limit GitHub Packages to the package scope`
    )
    assert(
      workflow.includes('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'),
      `${repository} published consumer must authenticate with its repository token`
    )
    for (const packageRepository of repositories) {
      const outputName = `${packageRepository.replaceAll('-', '_')}_ref`
      assert(
        workflow.includes(`ref: \${{ needs.resolve_release.outputs.${outputName} || 'main' }}`),
        `${repository} workflow must select ${packageRepository} from the release manifest during release verification`
      )
    }
  }
}

const releaseDirectory = new URL('authmodules/releases/', workspaceRoot)
for (const entry of await readdir(releaseDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue
  const release = entry.name.slice(0, -'.json'.length)
  parseReleaseManifest(
    await readJson(new URL(entry.name, releaseDirectory)),
    release
  )
}

const packedConsumer = await readFile(new URL('authmodules/scripts/check-packed-consumer.js', workspaceRoot), 'utf8')
assert(
  packedConsumer.includes("const installMode = publishedVersions ? ['--prefer-online'] : ['--offline']"),
  'published consumer must be allowed to fetch exact packages from the registry'
)
assert(
  !packedConsumer.includes('npm_config_registry'),
  'published consumer must preserve the default registry for unscoped dependencies'
)
assert(
  packedConsumer.includes('await retry(install, { attempts: 6, delayMilliseconds: 10_000 })'),
  'published consumer must tolerate bounded registry propagation delay'
)
assert(
  packedConsumer.includes("'--registry=https://npm.pkg.github.com'")
    && packedConsumer.includes('registry integrity does not match the release plan'),
  'published consumer must verify every registry package against the release plan integrity'
)

console.log('Release manifests passed')

function assertActionMajor(workflow, action, major, repository) {
  const references = workflow
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`uses: ${action}@`))
  assert(references.length > 0, `${repository} workflow must use ${action}`)
  assert(references.every((reference) => reference === `uses: ${action}@v${major}`), `${repository} workflow must use ${action}@v${major}`)
}

function assertCheckoutCredentialsDisabled(workflow, repository) {
  const lines = workflow.split('\n')
  const checkoutIndexes = lines
    .map((line, index) => line.trim() === 'uses: actions/checkout@v7' ? index : -1)
    .filter((index) => index >= 0)
  assert(checkoutIndexes.length > 0, `${repository} workflow must checkout source`)
  for (const index of checkoutIndexes) {
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s{6}- name:/.test(lines[cursor])) {
        end = cursor
        break
      }
    }
    const step = lines.slice(index, end).join('\n')
    assert(
      /^\s+persist-credentials: false$/m.test(step),
      `${repository} checkout must disable persisted credentials`
    )
  }
}

function assertToolchain(manifest, lock, repository) {
  assert(manifest.packageManager === expectedPackageManager, `${repository} packageManager must be ${expectedPackageManager}`)
  assert(
    JSON.stringify(manifest.devEngines?.packageManager) === JSON.stringify(expectedDevEngine),
    `${repository} devEngines.packageManager must enforce npm 11.16.0`
  )
}

function assertLockRootMatchesManifest(manifest, lock, repository) {
  const root = lock.packages?.['']
  assert(lock.name === manifest.name, `${repository} lockfile name must match package.json`)
  assert(lock.version === manifest.version, `${repository} lockfile version must match package.json`)
  assert(root && typeof root === 'object', `${repository} lockfile must contain a root package record`)
  for (const field of [
    'name',
    'version',
    'license',
    'engines',
    'devEngines',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies'
  ]) {
    assert(
      isDeepStrictEqual(root[field], manifest[field]),
      `${repository} lockfile root ${field} must match package.json`
    )
  }
}

function containsLocalDependency(value) {
  return /"(?:file|link):/.test(JSON.stringify(value))
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
