import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const snapshotPath = path.join(packageRoot, 'api-surface.json')
const manifestPath = path.join(packageRoot, 'package.json')
const write = process.argv.includes('--write')
const declarationExtensions = new Map([
  ['.js', '.d.ts'],
  ['.mjs', '.d.mts'],
  ['.cjs', '.d.cts'],
  ['.ts', '.d.ts'],
  ['.mts', '.d.mts'],
  ['.cts', '.d.cts']
])

if (process.argv.length > 3 || (process.argv.length === 3 && !write)) {
  throw new Error('Usage: node scripts/check-package-api.js [--write]')
}

assertDeclarationScanner()

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const snapshot = await createSnapshot(manifest)
const serializedSnapshot = `${JSON.stringify(snapshot, null, 2)}\n`

if (write) {
  await writeFile(snapshotPath, serializedSnapshot)
  console.log(`Public API snapshot updated for ${manifest.name}`)
} else {
  const committedSnapshot = parseSnapshot(
    await readFile(snapshotPath, 'utf8'),
    'Committed public API snapshot'
  )
  if (!snapshotsEqual(committedSnapshot, snapshot)) {
    throw new Error('Public API snapshot is stale; run npm run api:update and review the change')
  }
  await enforcePullRequestVersionPolicy(committedSnapshot, manifest.version)
  console.log(`Public API snapshot verified for ${manifest.name}`)
}

async function createSnapshot(packageManifest) {
  if (typeof packageManifest.name !== 'string' || typeof packageManifest.types !== 'string') {
    throw new Error('Package name and top-level types entrypoint are required')
  }

  const declarationFiles = await collectReachableDeclarationFiles(
    collectPublicTypeEntrypoints(packageManifest)
  )
  if (declarationFiles.length === 0) {
    throw new Error('No declarations are reachable from public package entrypoints')
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
    compatibility: {
      engines: packageManifest.engines ?? null,
      peerDependencies: packageManifest.peerDependencies ?? null,
      peerDependenciesMeta: packageManifest.peerDependenciesMeta ?? null
    },
    declarations: await Promise.all(declarationFiles.map(async (filePath) => ({
      path: normalizePath(path.relative(packageRoot, filePath)),
      sha256: createHash('sha256')
        .update(normalizeText(await readFile(filePath, 'utf8')))
        .digest('hex')
    })))
  }
}

function collectPublicTypeEntrypoints(packageManifest) {
  const entrypoints = new Set([packageManifest.types])
  collectDeclarationTargets(packageManifest.exports, entrypoints)
  return [...entrypoints].map(resolvePackageDeclaration)
}

function collectDeclarationTargets(value, targets) {
  if (typeof value === 'string') {
    if (/\.d\.(?:c|m)?ts$/.test(value)) targets.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectDeclarationTargets(entry, targets)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) collectDeclarationTargets(entry, targets)
  }
}

function resolvePackageDeclaration(target) {
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error(`Public declaration target must be package-relative, received ${String(target)}`)
  }
  const resolved = path.resolve(packageRoot, target)
  assertWithinPackage(resolved)
  return resolved
}

async function collectReachableDeclarationFiles(entrypoints) {
  const pending = [...entrypoints]
  const visited = new Set()

  while (pending.length > 0) {
    const filePath = pending.pop()
    if (visited.has(filePath)) continue
    const sourceText = await readFile(filePath, 'utf8')
    visited.add(filePath)
    for (const specifier of collectRelativeDeclarationSpecifiers(sourceText)) {
      pending.push(await resolveRelativeDeclaration(filePath, specifier))
    }
  }

  return [...visited].sort((left, right) => left.localeCompare(right))
}

function collectRelativeDeclarationSpecifiers(sourceText) {
  const specifiers = new Set()
  const referencePattern = /^\s*\/\/\/\s*<reference\s+path=['"](\.{1,2}\/[^'"]+)['"]/gm
  for (const match of sourceText.matchAll(referencePattern)) specifiers.add(match[1])

  const tokens = tokenizeDeclaration(sourceText)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'identifier') continue
    if (token.value === 'from' && tokens[index + 1]?.type === 'string') {
      addRelativeSpecifier(specifiers, tokens[index + 1].value)
    }
    if (
      (token.value === 'import' || token.value === 'require')
      && tokens[index + 1]?.value === '('
      && tokens[index + 2]?.type === 'string'
    ) {
      addRelativeSpecifier(specifiers, tokens[index + 2].value)
    }
    if (token.value === 'import' && tokens[index + 1]?.type === 'string') {
      addRelativeSpecifier(specifiers, tokens[index + 1].value)
    }
  }
  return specifiers
}

function tokenizeDeclaration(sourceText) {
  const tokens = []
  let index = 0

  while (index < sourceText.length) {
    const character = sourceText[index]
    const next = sourceText[index + 1]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (character === '/' && next === '/') {
      index = sourceText.indexOf('\n', index + 2)
      if (index === -1) break
      continue
    }
    if (character === '/' && next === '*') {
      const end = sourceText.indexOf('*/', index + 2)
      if (end === -1) throw new Error('Generated declaration contains an unterminated comment')
      index = end + 2
      continue
    }
    if (character === "'" || character === '"') {
      const stringToken = readStringToken(sourceText, index, character)
      tokens.push({ type: 'string', value: stringToken.value })
      index = stringToken.nextIndex
      continue
    }
    if (character === '`') {
      index = readStringToken(sourceText, index, character).nextIndex
      continue
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1
      while (/[A-Za-z0-9_$]/.test(sourceText[end] ?? '')) end += 1
      tokens.push({ type: 'identifier', value: sourceText.slice(index, end) })
      index = end
      continue
    }
    tokens.push({ type: 'punctuation', value: character })
    index += 1
  }

  return tokens
}

function readStringToken(sourceText, startIndex, quote) {
  let value = ''
  let index = startIndex + 1
  while (index < sourceText.length) {
    const character = sourceText[index]
    if (character === quote) return { value, nextIndex: index + 1 }
    if (character === '\\') {
      if (index + 1 >= sourceText.length) break
      value += sourceText[index + 1]
      index += 2
      continue
    }
    value += character
    index += 1
  }
  throw new Error('Generated declaration contains an unterminated string')
}

function addRelativeSpecifier(specifiers, value) {
  if (value.startsWith('./') || value.startsWith('../')) specifiers.add(value)
}

function assertDeclarationScanner() {
  const sourceText = `
    /** import './comment-only.js' and from './documentation-only.js' */
    /// <reference path="./reference.d.ts" />
    import type { PublicType } from './public.ts'
    export type LazyType = import('./lazy.js').PublicType
    type DocumentationLiteral = "from './string-only.js'"
  `
  const actual = [...collectRelativeDeclarationSpecifiers(sourceText)].sort()
  const expected = ['./lazy.js', './public.ts', './reference.d.ts']
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Declaration dependency scanner failed its internal invariant')
  }
}

async function resolveRelativeDeclaration(importer, specifier) {
  const unresolved = path.resolve(path.dirname(importer), specifier)
  assertWithinPackage(unresolved)
  const extension = path.extname(unresolved)
  const declarationExtension = declarationExtensions.get(extension)
  const candidates = /\.d\.(?:c|m)?ts$/.test(unresolved)
    ? [unresolved]
    : declarationExtension === undefined
      ? [`${unresolved}.d.ts`, path.join(unresolved, 'index.d.ts')]
      : [`${unresolved.slice(0, -extension.length)}${declarationExtension}`]

  for (const candidate of candidates) {
    assertWithinPackage(candidate)
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error(
    `${normalizePath(path.relative(packageRoot, importer))} references missing declaration ${specifier}`
  )
}

async function enforcePullRequestVersionPolicy(currentSnapshot, currentVersion) {
  const baseBranch = process.env.GITHUB_BASE_REF
  if (baseBranch === undefined || baseBranch.length === 0) return
  await execGit(['check-ref-format', '--branch', baseBranch])

  const baseRef = `origin/${baseBranch}`
  await execGit(['rev-parse', '--verify', baseRef])
  const baseSnapshotText = await readOptionalFileAtRef(baseRef, 'api-surface.json')
  if (baseSnapshotText === undefined) return
  const baseSnapshot = parseSnapshot(baseSnapshotText, `${baseRef} public API snapshot`)
  if (snapshotsEqual(baseSnapshot, currentSnapshot)) return

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

function normalizeText(value) {
  return value.replace(/\r\n?/g, '\n')
}

function parseSnapshot(value, label) {
  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('snapshot root must be an object')
    }
    return parsed
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`)
  }
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertWithinPackage(filePath) {
  if (filePath !== packageRoot && !filePath.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error(`Declaration path escapes the package root: ${filePath}`)
  }
}
