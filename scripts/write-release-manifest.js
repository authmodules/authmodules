import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  isExactIntegrity,
  isExactVersion,
  packageRepositories,
  parseReleaseManifest
} from './release-manifest.js'

const execFileAsync = promisify(execFile)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const release = process.argv[2]
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))

if (!isExactVersion(release)) {
  throw new Error('Usage: npm run release:prepare -- <exact-version>')
}
const centralManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (centralManifest.version !== release) {
  throw new Error(`Central package version must equal release ${release}`)
}
const expectedNpm = centralManifest.packageManager?.match(/^npm@(.+)$/)?.[1]
const actualNpm = (await run(npm, ['--version'], process.cwd())).trim()
if (expectedNpm !== actualNpm) {
  throw new Error(`release:prepare requires npm ${expectedNpm}`)
}

const packages = {}
for (const repository of packageRepositories) {
  const repositoryRoot = path.join(workspaceRoot, repository)
  await assertClean(repository, repositoryRoot)
  const packageManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
  if (packageManifest.name !== `@authmodules/${repository}` || !isExactVersion(packageManifest.version)) {
    throw new Error(`${repository} package name or version is invalid`)
  }
  const revision = (await run('git', ['rev-parse', 'HEAD'], repositoryRoot)).trim()
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`${repository} HEAD must resolve to one full commit revision`)
  }
  await run(npm, ['run', 'build', '--ignore-scripts'], repositoryRoot)
  await assertClean(repository, repositoryRoot)
  const packed = JSON.parse(await run(
    npm,
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    repositoryRoot
  ))
  if (!Array.isArray(packed)
    || packed.length !== 1
    || packed[0]?.name !== packageManifest.name
    || packed[0]?.version !== packageManifest.version) {
    throw new Error(`${repository} pack metadata does not match its package manifest`)
  }
  const integrity = packed?.[0]?.integrity
  if (!isExactIntegrity(integrity)) {
    throw new Error(`${repository} pack did not produce one exact SHA-512 integrity`)
  }
  packages[repository] = {
    repository: `authmodules/${repository}`,
    revision,
    tag: `v${packageManifest.version}`,
    version: packageManifest.version,
    integrity
  }
}

const manifest = parseReleaseManifest({
  schemaVersion: 2,
  release,
  packages
}, release)
const destination = new URL(`../releases/${release}.json`, import.meta.url)
await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Prepared ${path.relative(process.cwd(), fileURLToPath(destination))}`)

async function assertClean(repository, repositoryRoot) {
  const status = await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], repositoryRoot)
  if (status.trim().length > 0) {
    throw new Error(`${repository} must have a clean worktree before preparing a release manifest`)
  }
}

async function run(command, args, cwd) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout
}
