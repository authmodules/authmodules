import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, glob, readFile, writeFile } from 'node:fs/promises'
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
  ['.jsx', '.d.ts'],
  ['.mjs', '.d.mts'],
  ['.cjs', '.d.cts'],
  ['.ts', '.d.ts'],
  ['.tsx', '.d.ts'],
  ['.mts', '.d.mts'],
  ['.cts', '.d.cts']
])

if (process.argv.length > 3 || (process.argv.length === 3 && !write)) {
  throw new Error('Usage: node scripts/check-package-api.js [--write]')
}

await assertDeclarationScanner()

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

  const publicTypeEntrypoints = await collectPublicTypeEntrypoints(packageManifest)
  const declarationFiles = await collectReachableDeclarationFiles(publicTypeEntrypoints)
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
      peerDependenciesMeta: packageManifest.peerDependenciesMeta ?? null,
      typesVersions: packageManifest.typesVersions ?? null
    },
    declarations: await Promise.all(declarationFiles.map(async (filePath) => ({
      path: normalizePath(path.relative(packageRoot, filePath)),
      sha256: createHash('sha256')
        .update(declarationFingerprint(await readFile(filePath, 'utf8')))
        .digest('hex')
    })))
  }
}

async function collectPublicTypeEntrypoints(packageManifest) {
  const targets = new Set([packageManifest.types])
  collectDeclarationTargets(packageManifest.exports, targets)
  const entrypoints = new Set()

  for (const target of targets) {
    if (!target.includes('*')) {
      entrypoints.add(resolvePackageDeclaration(target))
      continue
    }
    const pattern = resolvePackageDeclaration(target)
    let matched = false
    for await (const relativePath of glob(normalizePath(path.relative(packageRoot, pattern)), {
      cwd: packageRoot
    })) {
      entrypoints.add(resolvePackageDeclaration(`./${normalizePath(relativePath)}`))
      matched = true
    }
    if (!matched) {
      throw new Error(`Public declaration pattern did not match any files: ${target}`)
    }
  }

  return [...entrypoints].sort((left, right) => left.localeCompare(right))
}

function collectDeclarationTargets(value, targets) {
  if (typeof value === 'string') {
    const declarationTarget = declarationTargetForExport(value)
    if (declarationTarget !== undefined) targets.add(declarationTarget)
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

function declarationTargetForExport(target) {
  if (/\.d\.(?:c|m)?ts$/.test(target)) return target
  const extension = path.extname(target)
  const declarationExtension = declarationExtensions.get(extension)
  if (declarationExtension === undefined) return undefined
  return `${target.slice(0, -extension.length)}${declarationExtension}`
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
  const referencePattern = /^\s*\/\/\/\s*<reference\s+path=['"]([^'"]+)['"]/gm
  for (const match of sourceText.matchAll(referencePattern)) {
    addRelativeReference(specifiers, match[1])
  }

  collectSpecifiersFromTokens(tokenizeDeclaration(sourceText), specifiers)
  return specifiers
}

function collectSpecifiersFromTokens(tokens, specifiers) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'template') {
      for (const expressionTokens of token.expressions) {
        collectSpecifiersFromTokens(expressionTokens, specifiers)
      }
      continue
    }
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
      const templateToken = readTemplateToken(sourceText, index)
      tokens.push({
        type: 'template',
        segments: templateToken.segments,
        expressions: templateToken.expressions
      })
      index = templateToken.nextIndex
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
      const escape = readEscapeSequence(sourceText, index)
      value += escape.value
      index = escape.nextIndex
      continue
    }
    value += character
    index += 1
  }
  throw new Error('Generated declaration contains an unterminated string')
}

function readTemplateToken(sourceText, startIndex) {
  const segments = []
  const expressions = []
  let segment = ''
  let index = startIndex + 1

  while (index < sourceText.length) {
    const character = sourceText[index]
    if (character === '`') {
      segments.push(segment)
      return { segments, expressions, nextIndex: index + 1 }
    }
    if (character === '\\') {
      if (index + 1 >= sourceText.length) break
      segment += `${character}${sourceText[index + 1]}`
      index += 2
      continue
    }
    if (character === '$' && sourceText[index + 1] === '{') {
      segments.push(segment)
      segment = ''
      const expression = readTemplateExpression(sourceText, index + 2)
      expressions.push(tokenizeDeclaration(expression.value))
      index = expression.nextIndex
      continue
    }
    segment += character
    index += 1
  }

  throw new Error('Generated declaration contains an unterminated template literal')
}

function readTemplateExpression(sourceText, startIndex) {
  let depth = 1
  let index = startIndex

  while (index < sourceText.length) {
    const character = sourceText[index]
    const next = sourceText[index + 1]
    if (character === "'" || character === '"') {
      index = readStringToken(sourceText, index, character).nextIndex
      continue
    }
    if (character === '`') {
      index = readTemplateToken(sourceText, index).nextIndex
      continue
    }
    if (character === '/' && next === '/') {
      index = sourceText.indexOf('\n', index + 2)
      if (index === -1) {
        throw new Error('Generated declaration contains an unterminated template expression')
      }
      continue
    }
    if (character === '/' && next === '*') {
      const end = sourceText.indexOf('*/', index + 2)
      if (end === -1) throw new Error('Generated declaration contains an unterminated comment')
      index = end + 2
      continue
    }
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) {
        return {
          value: sourceText.slice(startIndex, index),
          nextIndex: index + 1
        }
      }
    }
    index += 1
  }

  throw new Error('Generated declaration contains an unterminated template expression')
}

function readEscapeSequence(sourceText, startIndex) {
  const escaped = sourceText[startIndex + 1]
  if (escaped === undefined) {
    throw new Error('Generated declaration contains an unterminated escape sequence')
  }
  if (escaped === '\n') return { value: '', nextIndex: startIndex + 2 }
  if (escaped === '\r') {
    return {
      value: '',
      nextIndex: sourceText[startIndex + 2] === '\n' ? startIndex + 3 : startIndex + 2
    }
  }

  const simpleEscapes = new Map([
    ['0', '\0'],
    ['b', '\b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['v', '\v']
  ])
  if (simpleEscapes.has(escaped)) {
    return { value: simpleEscapes.get(escaped), nextIndex: startIndex + 2 }
  }
  if (escaped === 'x') {
    return readHexEscape(sourceText, startIndex, 2, 2)
  }
  if (escaped === 'u' && sourceText[startIndex + 2] === '{') {
    const end = sourceText.indexOf('}', startIndex + 3)
    if (end === -1) throw new Error('Generated declaration contains an invalid Unicode escape')
    const digits = sourceText.slice(startIndex + 3, end)
    if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) {
      throw new Error('Generated declaration contains an invalid Unicode code point escape')
    }
    const codePoint = Number.parseInt(digits, 16)
    if (codePoint > 0x10FFFF) {
      throw new Error('Generated declaration contains an out-of-range Unicode escape')
    }
    return { value: String.fromCodePoint(codePoint), nextIndex: end + 1 }
  }
  if (escaped === 'u') {
    return readHexEscape(sourceText, startIndex, 2, 4)
  }
  return { value: escaped, nextIndex: startIndex + 2 }
}

function readHexEscape(sourceText, startIndex, prefixLength, digitsLength) {
  const digitsStart = startIndex + prefixLength
  const digits = sourceText.slice(digitsStart, digitsStart + digitsLength)
  if (digits.length !== digitsLength || !/^[0-9A-Fa-f]+$/.test(digits)) {
    throw new Error('Generated declaration contains an invalid hexadecimal escape')
  }
  return {
    value: String.fromCodePoint(Number.parseInt(digits, 16)),
    nextIndex: digitsStart + digitsLength
  }
}

function addRelativeSpecifier(specifiers, value) {
  if (value.startsWith('./') || value.startsWith('../')) specifiers.add(value)
}

function addRelativeReference(specifiers, value) {
  if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) specifiers.add(value)
}

async function assertDeclarationScanner() {
  const sourceText = [
    "/** import './comment-only.js' and from './documentation-only.js' */",
    '/// <reference path="reference.d.ts" />',
    "import type { PublicType } from './public.tsx'",
    "export type LazyType = import('./lazy.js').PublicType",
    "export type EscapedType = import('./escaped\\u002ejs').PublicType",
    "export type TemplateType = `prefix${import('./template.js').PublicType}`",
    'type DocumentationLiteral = "from \'./string-only.js\'"',
    "type TemplateDocumentation = `import('./template-string-only.js')`"
  ].join('\n')
  const actual = [...collectRelativeDeclarationSpecifiers(sourceText)].sort()
  const expected = [
    './escaped.js',
    './lazy.js',
    './public.tsx',
    './template.js',
    'reference.d.ts'
  ]
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Declaration dependency scanner failed its internal invariant')
  }
  if (
    declarationTargetForExport('./dist/index.js') !== './dist/index.d.ts'
    || declarationTargetForExport('./dist/components/*.tsx') !== './dist/components/*.d.ts'
    || declarationTargetForExport('./dist/index.d.mts') !== './dist/index.d.mts'
  ) {
    throw new Error('Declaration export target mapping failed its internal invariant')
  }
  const changedDocumentation = sourceText.replace('comment-only.js', 'different-comment.js')
  if (declarationFingerprint(sourceText) !== declarationFingerprint(changedDocumentation)) {
    throw new Error('Declaration fingerprint must ignore non-semantic comments')
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

function declarationFingerprint(sourceText) {
  const normalized = normalizeText(sourceText)
  const referenceDirectives = [...normalized.matchAll(
    /^\s*\/\/\/\s*<reference\s+(?:path|types|lib)=['"][^'"]+['"]\s*\/?>/gm
  )].map((match) => match[0].trim())
  return JSON.stringify({
    referenceDirectives,
    tokens: tokenizeDeclaration(normalized)
  })
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
