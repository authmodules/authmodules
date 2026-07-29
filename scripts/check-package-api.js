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

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
await assertDeclarationScanner(manifest)
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
  const declarationFiles = await collectReachableDeclarationFiles(
    publicTypeEntrypoints,
    packageManifest
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
      engines: canonicalizeUnorderedObject(packageManifest.engines ?? null),
      peerDependencies: canonicalizeUnorderedObject(packageManifest.peerDependencies ?? null),
      peerDependenciesMeta: canonicalizeUnorderedObject(
        packageManifest.peerDependenciesMeta ?? null
      ),
      typesVersions: packageManifest.typesVersions ?? null,
      ...collectOptionalCompatibilityFields(packageManifest)
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
  collectTypesVersionsTargets(packageManifest.typesVersions, targets)
  const entrypoints = new Set()

  for (const target of targets) {
    if (!target.includes('*')) {
      entrypoints.add(await resolvePackageDeclarationEntrypoint(target))
      continue
    }
    let matched = false
    for (const targetPattern of declarationTargetPatterns(target)) {
      const pattern = resolvePackageDeclaration(targetPattern)
      for await (const relativePath of glob(
        normalizePath(path.relative(packageRoot, pattern)),
        { cwd: packageRoot }
      )) {
        if (!/\.d\.(?:c|m)?ts$/.test(relativePath)) continue
        entrypoints.add(resolvePackageDeclaration(`./${normalizePath(relativePath)}`))
        matched = true
      }
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

function collectTypesVersionsTargets(value, targets) {
  if (typeof value === 'string') {
    const packageTarget = value.startsWith('./') ? value : `./${value}`
    targets.add(declarationTargetForExport(packageTarget) ?? packageTarget)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTypesVersionsTargets(entry, targets)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) collectTypesVersionsTargets(entry, targets)
  }
}

function declarationTargetForExport(target) {
  if (/\.d\.(?:c|m)?ts$/.test(target)) return target
  const extension = path.extname(target)
  const declarationExtension = declarationExtensions.get(extension)
  if (declarationExtension === undefined) return undefined
  return `${target.slice(0, -extension.length)}${declarationExtension}`
}

function declarationTargetPatterns(target) {
  const declarationTarget = declarationTargetForExport(target)
  if (declarationTarget !== undefined) return [declarationTarget]
  return [
    target,
    `${target}.d.ts`,
    `${target}.d.mts`,
    `${target}.d.cts`,
    `${target}/index.d.ts`,
    `${target}/index.d.mts`,
    `${target}/index.d.cts`
  ]
}

function resolvePackageDeclaration(target) {
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error(`Public declaration target must be package-relative, received ${String(target)}`)
  }
  const resolved = path.resolve(packageRoot, target)
  assertWithinPackage(resolved)
  return resolved
}

async function resolvePackageDeclarationEntrypoint(target) {
  const unresolved = resolvePackageDeclaration(target)
  for (const candidate of declarationCandidates(unresolved)) {
    assertWithinPackage(candidate)
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`Public declaration target does not resolve to a declaration: ${target}`)
}

async function collectReachableDeclarationFiles(entrypoints, packageManifest) {
  const pending = [...entrypoints]
  const visited = new Set()

  while (pending.length > 0) {
    const filePath = pending.pop()
    if (visited.has(filePath)) continue
    const sourceText = await readFile(filePath, 'utf8')
    visited.add(filePath)
    for (const specifier of collectDeclarationSpecifiers(sourceText)) {
      if (specifier.startsWith('#')) {
        pending.push(...await resolvePackageImportDeclarations(packageManifest, specifier))
      } else {
        pending.push(await resolveRelativeDeclaration(filePath, specifier))
      }
    }
  }

  return [...visited].sort((left, right) => left.localeCompare(right))
}

function collectDeclarationSpecifiers(sourceText) {
  const specifiers = new Set()
  for (const directive of collectReferenceDirectives(sourceText)) {
    const pathAttribute = directive.attributes.find((attribute) => attribute.name === 'path')
    if (pathAttribute !== undefined) addRelativeReference(specifiers, pathAttribute.value)
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
      addDeclarationSpecifier(specifiers, tokens[index + 1].value)
    }
    if (
      (token.value === 'import' || token.value === 'require')
      && tokens[index + 1]?.value === '('
      && tokens[index + 2]?.type === 'string'
    ) {
      addDeclarationSpecifier(specifiers, tokens[index + 2].value)
    }
    if (token.value === 'import' && tokens[index + 1]?.type === 'string') {
      addDeclarationSpecifier(specifiers, tokens[index + 1].value)
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
      const semanticTags = collectSemanticJsDocTags(sourceText.slice(index, end + 2))
      if (semanticTags.length > 0) {
        tokens.push({ type: 'semantic-jsdoc', tags: semanticTags })
      }
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

function addDeclarationSpecifier(specifiers, value) {
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('#')) {
    specifiers.add(value)
  }
}

function addRelativeReference(specifiers, value) {
  if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) specifiers.add(value)
}

async function assertDeclarationScanner(packageManifest) {
  const sourceText = [
    "/** import './comment-only.js' and from './documentation-only.js' */",
    '/// <reference path="reference.d.ts" />',
    '/// <reference types="node" resolution-mode="import" preserve="true" />',
    '/// <reference no-default-lib="true" />',
    "import type { PublicType } from './public.tsx'",
    "export type LazyType = import('./lazy.js').PublicType",
    "export type EscapedType = import('./escaped\\u002ejs').PublicType",
    "export type TemplateType = `prefix${import('./template.js').PublicType}`",
    "export type PackageImportType = import('#model').PublicType",
    'type DocumentationLiteral = "from \'./string-only.js\'"',
    "type TemplateDocumentation = `import('./template-string-only.js')`"
  ].join('\n')
  const actual = [...collectDeclarationSpecifiers(sourceText)].sort()
  const expected = [
    '#model',
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
  const mappedImportDeclarations = await resolvePackageImportDeclarations({
    imports: {
      '#model': packageManifest.types
    }
  }, '#model')
  if (
    mappedImportDeclarations.length !== 1
    || mappedImportDeclarations[0] !== resolvePackageDeclaration(packageManifest.types)
  ) {
    throw new Error('Package import declaration mapping failed its internal invariant')
  }
  const entrypointDirectory = path.posix.dirname(packageManifest.types)
  const typesVersionsEntrypoints = await collectPublicTypeEntrypoints({
    types: packageManifest.types,
    typesVersions: {
      '*': {
        '*': [`${entrypointDirectory.replace(/^\.\//, '')}/*`]
      }
    }
  })
  if (!typesVersionsEntrypoints.includes(resolvePackageDeclaration(packageManifest.types))) {
    throw new Error('typesVersions declaration discovery failed its internal invariant')
  }
  const changedDocumentation = sourceText.replace('comment-only.js', 'different-comment.js')
  if (declarationFingerprint(sourceText) !== declarationFingerprint(changedDocumentation)) {
    throw new Error('Declaration fingerprint must ignore non-semantic comments')
  }
  const deprecatedSource = sourceText.replace(
    'export type LazyType',
    '/** @deprecated */\nexport type LazyType'
  )
  if (declarationFingerprint(sourceText) === declarationFingerprint(deprecatedSource)) {
    throw new Error('Declaration fingerprint must retain semantic JSDoc tags')
  }
  const changedResolutionMode = sourceText.replace(
    'resolution-mode="import"',
    'resolution-mode="require"'
  )
  if (declarationFingerprint(sourceText) === declarationFingerprint(changedResolutionMode)) {
    throw new Error('Declaration fingerprint must retain reference directive attributes')
  }
  if (
    JSON.stringify(canonicalizeUnorderedObject({ z: { b: 1, a: 2 }, a: 3 }))
      !== '{"a":3,"z":{"a":2,"b":1}}'
  ) {
    throw new Error('Unordered manifest canonicalization failed its internal invariant')
  }
}

async function resolveRelativeDeclaration(importer, specifier) {
  const unresolved = path.resolve(path.dirname(importer), specifier)
  assertWithinPackage(unresolved)
  const candidates = declarationCandidates(unresolved)

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

function declarationCandidates(unresolved) {
  const extension = path.extname(unresolved)
  const declarationExtension = declarationExtensions.get(extension)
  return /\.d\.(?:c|m)?ts$/.test(unresolved)
    ? [unresolved]
    : declarationExtension === undefined
      ? [`${unresolved}.d.ts`, path.join(unresolved, 'index.d.ts')]
      : [`${unresolved.slice(0, -extension.length)}${declarationExtension}`]
}

async function resolvePackageImportDeclarations(packageManifest, specifier) {
  const imports = packageManifest.imports
  if (imports === null || typeof imports !== 'object' || Array.isArray(imports)) {
    throw new Error(`${specifier} is not mapped by package.json imports`)
  }

  let mapping
  let wildcardValue
  if (Object.hasOwn(imports, specifier)) {
    mapping = imports[specifier]
  } else {
    const matches = []
    for (const [key, value] of Object.entries(imports)) {
      const wildcardIndex = key.indexOf('*')
      if (wildcardIndex === -1 || wildcardIndex !== key.lastIndexOf('*')) continue
      const prefix = key.slice(0, wildcardIndex)
      const suffix = key.slice(wildcardIndex + 1)
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
      matches.push({
        prefixLength: prefix.length,
        suffixLength: suffix.length,
        wildcardValue: specifier.slice(prefix.length, specifier.length - suffix.length),
        value
      })
    }
    matches.sort((left, right) => (
      right.prefixLength - left.prefixLength || right.suffixLength - left.suffixLength
    ))
    mapping = matches[0]?.value
    wildcardValue = matches[0]?.wildcardValue
  }

  if (mapping === undefined) {
    throw new Error(`${specifier} is not mapped by package.json imports`)
  }
  const targets = []
  collectPackageImportTargets(mapping, wildcardValue, targets)
  return Promise.all(targets.map(resolvePackageDeclarationEntrypoint))
}

function collectPackageImportTargets(value, wildcardValue, targets) {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) return
    const substituted = wildcardValue === undefined
      ? value
      : value.replaceAll('*', wildcardValue)
    targets.push(declarationTargetForExport(substituted) ?? substituted)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectPackageImportTargets(entry, wildcardValue, targets)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectPackageImportTargets(entry, wildcardValue, targets)
    }
  }
}

async function enforcePullRequestVersionPolicy(currentSnapshot, currentVersion) {
  const baseBranch = process.env.GITHUB_BASE_REF
  const baseSha = process.env.GITHUB_BASE_SHA
  if (
    (baseBranch === undefined || baseBranch.length === 0)
    && (baseSha === undefined || baseSha.length === 0)
  ) return

  let baseRef
  if (baseSha !== undefined && baseSha.length > 0) {
    if (!/^[0-9a-f]{40}$/.test(baseSha)) {
      throw new Error('GITHUB_BASE_SHA must be a full lowercase commit SHA')
    }
    baseRef = baseSha
    await execGit(['rev-parse', '--verify', `${baseRef}^{commit}`])
  } else {
    await execGit(['check-ref-format', '--branch', baseBranch])
    baseRef = `origin/${baseBranch}`
    await execGit(['rev-parse', '--verify', baseRef])
  }
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
  return JSON.stringify({
    referenceDirectives: collectReferenceDirectives(normalized),
    tokens: tokenizeDeclaration(normalized)
  })
}

function collectReferenceDirectives(sourceText) {
  const directives = []
  const directivePattern = /^\s*\/\/\/\s*<reference\b([^>]*)\/?>\s*$/gm
  for (const match of sourceText.matchAll(directivePattern)) {
    const attributes = []
    const attributePattern = /([A-Za-z][\w-]*)\s*=\s*(['"])(.*?)\2/g
    for (const attribute of match[1].matchAll(attributePattern)) {
      attributes.push({ name: attribute[1], value: attribute[3] })
    }
    attributes.sort((left, right) => (
      left.name.localeCompare(right.name) || left.value.localeCompare(right.value)
    ))
    if (attributes.length > 0) directives.push({ attributes })
  }
  return directives
}

function collectSemanticJsDocTags(comment) {
  return [...comment.matchAll(/@(deprecated)\b/g)]
    .map((match) => match[1])
    .sort((left, right) => left.localeCompare(right))
}

function collectOptionalCompatibilityFields(packageManifest) {
  const fields = {}
  if (packageManifest.imports !== undefined) fields.imports = packageManifest.imports
  for (const key of ['os', 'cpu', 'libc']) {
    if (packageManifest[key] === undefined) continue
    fields[key] = Array.isArray(packageManifest[key])
      ? [...packageManifest[key]].sort((left, right) => left.localeCompare(right))
      : packageManifest[key]
  }
  return fields
}

function canonicalizeUnorderedObject(value) {
  if (Array.isArray(value)) return value.map(canonicalizeUnorderedObject)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeUnorderedObject(entry)])
  )
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
