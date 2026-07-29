import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const snapshotPath = path.join(packageRoot, 'api-surface.json')
const manifestPath = path.join(packageRoot, 'package.json')
const write = process.argv.includes('--write')

if (process.argv.length > 3 || (process.argv.length === 3 && !write)) {
  throw new Error('Usage: node scripts/check-package-api.js [--write]')
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const snapshot = await createSnapshot(manifest)
const serializedSnapshot = `${JSON.stringify(snapshot, null, 2)}\n`

if (write) {
  await writeFile(snapshotPath, serializedSnapshot)
  console.log(`Public API snapshot updated for ${manifest.name}`)
} else {
  const committedSnapshot = await readFile(snapshotPath, 'utf8')
  if (committedSnapshot !== serializedSnapshot) {
    throw new Error('Public API snapshot is stale; run npm run api:update and review the change')
  }
  await enforcePullRequestVersionPolicy(committedSnapshot, manifest.version)
  console.log(`Public API snapshot verified for ${manifest.name}`)
}

async function createSnapshot(packageManifest) {
  if (typeof packageManifest.name !== 'string' || typeof packageManifest.types !== 'string') {
    throw new Error('Package name and top-level types entrypoint are required')
  }

  const declarationRoot = path.dirname(path.join(packageRoot, packageManifest.types))
  const declarationFiles = await collectDeclarationFiles(declarationRoot)
  if (declarationFiles.length === 0) {
    throw new Error(`No declaration files found below ${path.relative(packageRoot, declarationRoot)}`)
  }

  return {
    schemaVersion: 1,
    package: packageManifest.name,
    entrypoints: {
      type: packageManifest.type ?? null,
      main: packageManifest.main ?? null,
      types: packageManifest.types,
      exports: packageManifest.exports ?? null
    },
    declarations: await Promise.all(declarationFiles.map(async (filePath) => ({
      path: normalizePath(path.relative(packageRoot, filePath)),
      sha256: createHash('sha256').update(await readFile(filePath)).digest('hex')
    })))
  }
}

async function collectDeclarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectDeclarationFiles(entryPath))
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(entryPath)
    }
  }

  return files
}

async function enforcePullRequestVersionPolicy(currentSnapshot, currentVersion) {
  const baseBranch = process.env.GITHUB_BASE_REF
  if (baseBranch === undefined || baseBranch.length === 0) return
  if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch)) {
    throw new Error('GITHUB_BASE_REF contains unsupported characters')
  }

  const baseRef = `origin/${baseBranch}`
  await execGit(['rev-parse', '--verify', baseRef])
  const baseSnapshot = await readOptionalFileAtRef(baseRef, 'api-surface.json')
  if (baseSnapshot === undefined || baseSnapshot === currentSnapshot) return

  const baseManifestText = await readRequiredFileAtRef(baseRef, 'package.json')
  const baseVersion = JSON.parse(baseManifestText).version
  assertConservativeApiVersionBump(baseVersion, currentVersion)
}

function assertConservativeApiVersionBump(baseVersion, currentVersion) {
  const base = parseVersion(baseVersion)
  const current = parseVersion(currentVersion)
  const valid = base.major === 0
    ? current.major > 0 || (current.major === 0 && current.minor > base.minor)
    : current.major > base.major

  if (!valid) {
    const required = base.major === 0
      ? `at least 0.${base.minor + 1}.0`
      : `at least ${base.major + 1}.0.0`
    throw new Error(
      `Public API changed from ${baseVersion}; version ${currentVersion} is insufficient. `
      + `Use ${required} under the conservative compatibility policy`
    )
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (match === null) {
    throw new Error(`Expected an exact stable semantic version, received ${String(value)}`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}

async function readOptionalFileAtRef(ref, filePath) {
  const { stdout } = await execGit(['ls-tree', '--name-only', ref, '--', filePath])
  if (stdout.trim() === '') return undefined
  return readRequiredFileAtRef(ref, filePath)
}

async function readRequiredFileAtRef(ref, filePath) {
  const { stdout } = await execGit(['show', `${ref}:${filePath}`])
  return stdout
}

async function execGit(args) {
  return execFileAsync(
    'git',
    ['-C', packageRoot, ...args],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  )
}

function normalizePath(value) {
  return value.split(path.sep).join('/')
}
