import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, glob, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { assertConservativeApiRelease } from './package-version-policy.js'

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(process.cwd())
const repositoryRoot = (
  await execFileAsync(
    'git',
    ['-C', packageRoot, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  )
).stdout.trim()
const packagePathFromRepository = normalizePath(path.relative(repositoryRoot, packageRoot))
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
const resolutionResolved = 'resolved'
const resolutionUndefined = 'undefined'
const resolutionInvalid = 'invalid'
const maximumEnumeratedConditions = 12

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
  if (typeof packageManifest.name !== 'string') {
    throw new Error('Package name is required')
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
      types: packageManifest.types ?? null,
      exports: packageManifest.exports ?? null
    },
    compatibility: {
      engines: canonicalizeUnorderedObject(packageManifest.engines ?? null),
      peerDependencies: canonicalizeUnorderedObject(packageManifest.peerDependencies ?? null),
      peerDependenciesMeta: canonicalizeUnorderedObject(
        packageManifest.peerDependenciesMeta ?? null
      ),
      typesVersions: packageManifest.typesVersions ?? null,
      ...collectOptionalCompatibilityFields(packageManifest),
      sideEffects: packageManifest.sideEffects ?? null
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
  const targetGroups = []
  if (packageManifest.types !== undefined) {
    targetGroups.push(new Set([normalizeTopLevelTypesTarget(packageManifest.types)]))
  }
  collectDeclarationTargetGroups(packageManifest.exports, targetGroups)
  collectTypesVersionsTargetGroups(packageManifest.typesVersions, targetGroups)
  if (targetGroups.length === 0) {
    throw new Error('At least one public type entrypoint is required through types or exports')
  }
  const entrypoints = new Set()

  for (const targetGroup of targetGroups) {
    const resolved = await resolveDeclarationTargetGroup(targetGroup)
    if (resolved.length === 0) {
      throw new Error(
        `No public declaration target resolved from: ${[...targetGroup].join(', ')}`
      )
    }
    for (const entrypoint of resolved) entrypoints.add(entrypoint)
  }

  return [...entrypoints].sort((left, right) => left.localeCompare(right))
}

function collectDeclarationTargetGroups(value, groups) {
  if (value === undefined) return
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    const subpathKeys = entries.filter(([key]) => key.startsWith('.')).length
    if (subpathKeys > 0 && subpathKeys !== entries.length) {
      throw new Error('Package exports cannot mix subpath and condition keys')
    }
    if (subpathKeys === entries.length) {
      for (const [subpath, entry] of entries) {
        collectConditionalTargetGroups(
          entry,
          groups,
          collectExportStringTarget,
          `Package export ${subpath}`
        )
      }
      return
    }
  }
  collectConditionalTargetGroups(
    value,
    groups,
    collectExportStringTarget,
    'Package exports'
  )
}

function collectExportStringTarget(target, groups) {
  if (!isValidLocalPackageTarget(target)) return resolutionInvalid
  if (target !== './package.json') {
    addSingletonTargetGroup(groups, declarationTargetForExport(target) ?? target)
  }
  return resolutionResolved
}

function collectConditionalTargetGroups(value, groups, collectStringTarget, label) {
  const conditionNames = new Set()
  collectConditionNames(value, conditionNames)
  if (conditionNames.size > maximumEnumeratedConditions) {
    throw new Error(
      `${label} contains too many custom conditions to verify exhaustively`
    )
  }
  const names = [...conditionNames]
  const combinationCount = 2 ** names.length
  for (let mask = 0; mask < combinationCount; mask += 1) {
    const activeConditions = new Set(['types'])
    for (let index = 0; index < names.length; index += 1) {
      if ((mask & 2 ** index) !== 0) activeConditions.add(names[index])
    }
    const resolution = resolveConditionalTarget(
      value,
      activeConditions,
      groups,
      collectStringTarget
    )
    if (resolution === resolutionInvalid) {
      throw new Error(`${label} contains an invalid package target`)
    }
  }
}

function collectConditionNames(value, names) {
  if (Array.isArray(value)) {
    for (const entry of value) collectConditionNames(entry, names)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [condition, entry] of Object.entries(value)) {
    if (condition !== 'default' && condition !== 'types') names.add(condition)
    collectConditionNames(entry, names)
  }
}

function resolveConditionalTarget(value, activeConditions, groups, collectStringTarget) {
  if (typeof value === 'string') return collectStringTarget(value, groups)
  if (value === null) return resolutionResolved
  if (value === undefined) return resolutionUndefined
  if (Array.isArray(value)) {
    if (value.length === 0) return resolutionResolved
    let lastInvalid = false
    for (const entry of value) {
      const resolution = resolveConditionalTarget(
        entry,
        activeConditions,
        groups,
        collectStringTarget
      )
      if (resolution === resolutionResolved) return resolutionResolved
      if (resolution === resolutionInvalid) lastInvalid = true
    }
    return lastInvalid ? resolutionInvalid : resolutionResolved
  }
  if (typeof value !== 'object') return resolutionInvalid

  if (Object.keys(value).some(isArrayIndexKey)) return resolutionInvalid
  for (const [condition, entry] of Object.entries(value)) {
    if (
      condition !== 'default'
      && !activeConditions.has(condition)
    ) continue
    const resolution = resolveConditionalTarget(
      entry,
      activeConditions,
      groups,
      collectStringTarget
    )
    if (resolution !== resolutionUndefined) return resolution
  }
  return resolutionUndefined
}

function addSingletonTargetGroup(groups, target) {
  if (!groups.some((group) => group.size === 1 && group.has(target))) {
    groups.push(new Set([target]))
  }
}

function isArrayIndexKey(key) {
  const index = Number(key)
  return (
    Number.isInteger(index)
    && index >= 0
    && index < 2 ** 32 - 1
    && String(index) === key
  )
}

function isValidLocalPackageTarget(target) {
  if (!target.startsWith('./') || target.includes('\\') || /%2f|%5c/i.test(target)) {
    return false
  }
  for (const rawSegment of target.slice(2).split('/')) {
    let segment
    try {
      segment = decodeURIComponent(rawSegment).split(/[?#]/, 1)[0]
    } catch {
      return false
    }
    if (
      segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.toLowerCase() === 'node_modules'
    ) {
      return false
    }
  }
  return true
}

function isValidExternalPackageTarget(target) {
  if (
    target.length === 0
    || target.startsWith('../')
    || target.startsWith('/')
    || target.includes('\\')
    || target.includes('%')
  ) {
    return false
  }
  try {
    new URL(target)
    return false
  } catch {
    // Bare package targets are intentionally not valid URLs.
  }
  const parts = target.split('/')
  const packageName = target.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0]
  return (
    packageName.length > 0
    && !packageName.startsWith('.')
    && (!target.startsWith('@') || parts.length >= 2 && parts[1].length > 0)
  )
}

function collectTypesVersionsTargetGroups(value, groups) {
  if (typeof value === 'string') {
    const packageTarget = value.startsWith('./') ? value : `./${value}`
    groups.push(new Set([declarationTargetForExport(packageTarget) ?? packageTarget]))
    return
  }
  if (Array.isArray(value)) {
    const alternatives = new Set()
    for (const entry of value) {
      const entryGroups = []
      collectTypesVersionsTargetGroups(entry, entryGroups)
      for (const group of entryGroups) {
        for (const target of group) alternatives.add(target)
      }
    }
    if (alternatives.size > 0) groups.push(alternatives)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectTypesVersionsTargetGroups(entry, groups)
    }
  }
}

async function resolveDeclarationTargetGroup(targets) {
  const resolved = new Set()
  for (const target of targets) {
    if (!target.includes('*')) {
      const entrypoint = await findPackageDeclarationEntrypoint(target)
      if (entrypoint !== undefined) resolved.add(entrypoint)
      continue
    }
    for (const targetPattern of declarationTargetPatterns(target)) {
      const pattern = resolvePackageDeclaration(targetPattern)
      for await (const relativePath of glob(
        normalizePath(path.relative(packageRoot, pattern)),
        { cwd: packageRoot }
      )) {
        if (!/\.d\.(?:c|m)?ts$/.test(relativePath)) continue
        resolved.add(resolvePackageDeclaration(`./${normalizePath(relativePath)}`))
      }
    }
  }
  return [...resolved]
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

function normalizeTopLevelTypesTarget(target) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Top-level types entrypoint must be a non-empty package-relative path')
  }
  if (
    path.isAbsolute(target)
    || /^[A-Za-z]:[\\/]/.test(target)
    || /^[A-Za-z][A-Za-z+.-]*:/.test(target)
  ) {
    throw new Error(`Top-level types entrypoint must be package-relative, received ${target}`)
  }
  return target.startsWith('./') ? target : `./${target}`
}

async function findPackageDeclarationEntrypoint(target) {
  const unresolved = resolvePackageDeclaration(target)
  for (const candidate of declarationCandidates(unresolved)) {
    assertWithinPackage(candidate)
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    }
  }
  return undefined
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
    "type TemplateDocumentation = `import('./template-string-only.js')`",
    'type TemplateReference = `',
    '/// <reference path="template-reference-only.d.ts" />',
    '`',
    '/*',
    '/// <reference path="block-comment-only.d.ts" />',
    '*/'
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
  const packageEntrypoints = await collectPublicTypeEntrypoints(packageManifest)
  const selfTestEntrypoint = packageEntrypoints[0]
  const selfTestTarget = `./${normalizePath(path.relative(packageRoot, selfTestEntrypoint))}`
  const selfTestRuntimeTarget = selfTestTarget
    .replace(/\.d\.mts$/, '.mjs')
    .replace(/\.d\.cts$/, '.cjs')
    .replace(/\.d\.ts$/, '.js')
  const mappedImportDeclarations = await resolvePackageImportDeclarations({
    imports: {
      '#model': {
        custom: selfTestRuntimeTarget,
        types: selfTestTarget,
        default: './missing-after-types.js'
      }
    }
  }, '#model')
  if (
    mappedImportDeclarations.length !== 1
    || mappedImportDeclarations[0] !== selfTestEntrypoint
  ) {
    throw new Error('Package import declaration mapping failed its internal invariant')
  }
  const fallbackImportDeclarations = await resolvePackageImportDeclarations({
    imports: {
      '#fallback': [selfTestRuntimeTarget, './missing-fallback.cjs']
    }
  }, '#fallback')
  if (
    fallbackImportDeclarations.length !== 1
    || fallbackImportDeclarations[0] !== selfTestEntrypoint
  ) {
    throw new Error('Package import fallback mapping failed its internal invariant')
  }
  let missingPrimaryImportRejected = false
  try {
    await resolvePackageImportDeclarations({
      imports: {
        '#fallback': ['./missing-primary.cjs', selfTestRuntimeTarget]
      }
    }, '#fallback')
  } catch (error) {
    missingPrimaryImportRejected = String(error).includes('./missing-primary.d.cts')
  }
  if (!missingPrimaryImportRejected) {
    throw new Error('Package import fallback order failed its internal invariant')
  }
  const entrypointDirectory = path.posix.dirname(selfTestTarget)
  const typesVersionsEntrypoints = await collectPublicTypeEntrypoints({
    types: selfTestTarget.slice(2),
    typesVersions: {
      '*': {
        '*': [`${entrypointDirectory.replace(/^\.\//, '')}/*`]
      }
    }
  })
  if (!typesVersionsEntrypoints.includes(selfTestEntrypoint)) {
    throw new Error('typesVersions declaration discovery failed its internal invariant')
  }
  const explicitTypeEntrypoints = await collectPublicTypeEntrypoints({
    exports: {
      '.': {
        custom: selfTestRuntimeTarget,
        types: selfTestTarget,
        import: './missing-after-types.js',
        require: './missing-after-types.cjs'
      }
    }
  })
  if (
    explicitTypeEntrypoints.length !== 1
    || explicitTypeEntrypoints[0] !== selfTestEntrypoint
  ) {
    throw new Error('Explicit export type condition handling failed its internal invariant')
  }
  const fallbackExportEntrypoints = await collectPublicTypeEntrypoints({
    exports: {
      '.': [selfTestRuntimeTarget, './missing-fallback.cjs']
    }
  })
  if (
    fallbackExportEntrypoints.length !== 1
    || fallbackExportEntrypoints[0] !== selfTestEntrypoint
  ) {
    throw new Error('Export fallback mapping failed its internal invariant')
  }
  let missingPrimaryExportRejected = false
  try {
    await collectPublicTypeEntrypoints({
      exports: {
        '.': ['./missing-primary.cjs', selfTestRuntimeTarget]
      }
    })
  } catch (error) {
    missingPrimaryExportRejected = String(error).includes('./missing-primary.d.cts')
  }
  if (!missingPrimaryExportRejected) {
    throw new Error('Export fallback order failed its internal invariant')
  }
  const conditionalFallbackGroups = []
  collectDeclarationTargetGroups([
    { browser: './browser.js' },
    selfTestRuntimeTarget
  ], conditionalFallbackGroups)
  if (
    JSON.stringify(
      conditionalFallbackGroups.flatMap((group) => [...group]).sort()
    )
    !== JSON.stringify(['./browser.d.ts', selfTestTarget].sort())
  ) {
    throw new Error('Conditional export fallback reachability failed its internal invariant')
  }
  const terminalFallbackGroups = []
  collectDeclarationTargetGroups([
    {
      browser: selfTestRuntimeTarget,
      types: selfTestTarget
    },
    './missing-after-types.js'
  ], terminalFallbackGroups)
  if (
    terminalFallbackGroups.some((group) => group.has('./missing-after-types.d.ts'))
  ) {
    throw new Error('Terminal export fallback handling failed its internal invariant')
  }
  const correlatedConditionGroups = []
  collectDeclarationTargetGroups([
    { browser: null },
    {
      browser: './missing-browser.js',
      default: selfTestRuntimeTarget
    }
  ], correlatedConditionGroups)
  const correlatedInvalidConditionGroups = []
  collectDeclarationTargetGroups([
    { browser: null },
    {
      browser: 'not:valid',
      default: selfTestRuntimeTarget
    }
  ], correlatedInvalidConditionGroups)
  if (
    correlatedConditionGroups.length !== 1
    || correlatedConditionGroups[0].has('./missing-browser.d.ts')
    || correlatedInvalidConditionGroups.length !== 1
  ) {
    throw new Error('Correlated export conditions failed their internal invariant')
  }
  const invalidFallbackGroups = []
  collectDeclarationTargetGroups(['not:valid', selfTestRuntimeTarget], invalidFallbackGroups)
  const blockedFallbackGroups = []
  collectDeclarationTargetGroups([null, selfTestRuntimeTarget], blockedFallbackGroups)
  const nestedFallbackGroups = []
  collectDeclarationTargetGroups([
    [selfTestRuntimeTarget, './missing-nested-fallback.js'],
    './missing-outer-fallback.js'
  ], nestedFallbackGroups)
  const nestedInvalidFallbackGroups = []
  collectDeclarationTargetGroups([
    ['not:valid'],
    selfTestRuntimeTarget
  ], nestedInvalidFallbackGroups)
  const extensionlessGroups = []
  collectDeclarationTargetGroups('./feature', extensionlessGroups)
  let invalidConditionRejected = false
  try {
    collectDeclarationTargetGroups({
      default: 'not:valid',
      types: selfTestTarget
    }, [])
  } catch (error) {
    invalidConditionRejected = String(error).includes('invalid package target')
  }
  let indexedConditionRejected = false
  try {
    collectDeclarationTargetGroups({ 0: selfTestTarget }, [])
  } catch (error) {
    indexedConditionRejected = String(error).includes('invalid package target')
  }
  if (
    invalidFallbackGroups.length !== 1
    || blockedFallbackGroups.length !== 0
    || nestedFallbackGroups.length !== 1
    || nestedFallbackGroups[0].has('./missing-nested-fallback.d.ts')
    || nestedInvalidFallbackGroups.length !== 1
    || extensionlessGroups.length !== 1
    || !extensionlessGroups[0].has('./feature')
    || !invalidConditionRejected
    || !indexedConditionRejected
  ) {
    throw new Error('Export fallback terminal handling failed its internal invariant')
  }
  const invalidImportFallbackGroups = []
  collectPackageImportTargetGroups([
    '../invalid.js',
    selfTestRuntimeTarget
  ], undefined, invalidImportFallbackGroups)
  const externalImportFallbackGroups = []
  collectPackageImportTargetGroups([
    '@authmodules/contracts',
    './missing-after-external.js'
  ], undefined, externalImportFallbackGroups)
  if (
    invalidImportFallbackGroups.length !== 1
    || externalImportFallbackGroups.length !== 0
  ) {
    throw new Error('Package import target validation failed its internal invariant')
  }
  const nestedExportGroups = []
  collectDeclarationTargetGroups({
    custom: {
      browser: './nested-browser.js',
      types: './nested.d.ts',
      default: './nested-default.js'
    },
    types: './root.d.ts',
    default: './root-default.js'
  }, nestedExportGroups)
  const nestedExportTargets = new Set(
    nestedExportGroups.flatMap((group) => [...group])
  )
  if (
    JSON.stringify([...nestedExportTargets].sort()) !== JSON.stringify([
      './nested-browser.d.ts',
      './nested.d.ts',
      './root.d.ts'
    ])
  ) {
    throw new Error('Nested export type condition handling failed its internal invariant')
  }
  const nestedImportGroups = []
  collectPackageImportTargetGroups({
    browser: './custom-*.js',
    custom: {
      browser: './nested-browser-*.js',
      types: './nested-*.d.ts'
    },
    types: './root-*.d.ts',
    default: './missing-after-types-*.js'
  }, 'model', nestedImportGroups)
  const nestedImportTargets = new Set(
    nestedImportGroups.flatMap((group) => [...group])
  )
  if (
    JSON.stringify([...nestedImportTargets].sort()) !== JSON.stringify([
      './custom-model.d.ts',
      './nested-model.d.ts',
      './root-model.d.ts'
    ])
  ) {
    throw new Error('Nested package import type condition handling failed its internal invariant')
  }
  const normalizedLegacySnapshot = normalizeLegacySnapshot({
    schemaVersion: 1,
    compatibility: { typesVersions: null }
  }, { sideEffects: false })
  if (
    normalizedLegacySnapshot.compatibility.sideEffects !== false
    || Object.hasOwn(normalizedLegacySnapshot, 'sideEffects')
  ) {
    throw new Error('Legacy API snapshot normalization failed its internal invariant')
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
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
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
  const targetGroups = []
  collectPackageImportTargetGroups(mapping, wildcardValue, targetGroups)
  const declarations = new Set()
  for (const targetGroup of targetGroups) {
    const resolved = await resolveDeclarationTargetGroup(targetGroup)
    if (resolved.length === 0) {
      throw new Error(
        `${specifier} declaration target did not resolve from: ${[...targetGroup].join(', ')}`
      )
    }
    for (const declaration of resolved) declarations.add(declaration)
  }
  return [...declarations]
}

function collectPackageImportTargetGroups(value, wildcardValue, groups) {
  collectConditionalTargetGroups(
    value,
    groups,
    (target, targetGroups) => {
      if (!target.startsWith('./')) {
        return isValidExternalPackageTarget(target)
          ? resolutionResolved
          : resolutionInvalid
      }
      const substituted = wildcardValue === undefined
        ? target
        : target.replaceAll('*', wildcardValue)
      if (!isValidLocalPackageTarget(substituted)) return resolutionInvalid
      addSingletonTargetGroup(
        targetGroups,
        declarationTargetForExport(substituted) ?? substituted
      )
      return resolutionResolved
    },
    'Package imports'
  )
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
  const baseManifestText = await readRequiredFileAtRef(baseRef, 'package.json')
  const baseManifest = JSON.parse(baseManifestText)
  const normalizedBaseSnapshot = normalizeLegacySnapshot(baseSnapshot, baseManifest)
  if (snapshotsEqual(normalizedBaseSnapshot, currentSnapshot)) return

  const baseVersion = baseManifest.version
  assertConservativeApiRelease(
    baseVersion,
    currentVersion,
    process.env.AUTHMODULES_PR_TITLE
  )
}

function normalizeLegacySnapshot(snapshot, packageManifest) {
  if (
    snapshot.compatibility === null
    || typeof snapshot.compatibility !== 'object'
    || Array.isArray(snapshot.compatibility)
    || Object.hasOwn(snapshot.compatibility, 'sideEffects')
  ) {
    return snapshot
  }
  return {
    ...snapshot,
    compatibility: {
      ...snapshot.compatibility,
      sideEffects: packageManifest.sideEffects ?? null
    }
  }
}

async function readOptionalFileAtRef(ref, filePath) {
  const repositoryFilePath = packageFileAtRepositoryRoot(filePath)
  const { stdout } = await execGit([
    'ls-tree',
    '--name-only',
    ref,
    '--',
    `:(top)${repositoryFilePath}`
  ])
  if (stdout.trim() === '') return undefined
  return readRequiredFileAtRef(ref, filePath)
}

async function readRequiredFileAtRef(ref, filePath) {
  const { stdout } = await execGit(['show', `${ref}:${packageFileAtRepositoryRoot(filePath)}`])
  return stdout
}

async function execGit(args) {
  return execFileAsync(
    'git',
    ['-C', repositoryRoot, ...args],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  )
}

function packageFileAtRepositoryRoot(filePath) {
  return packagePathFromRepository.length === 0
    ? normalizePath(filePath)
    : path.posix.join(packagePathFromRepository, normalizePath(filePath))
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
  let index = 0

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
    if (character === '/' && next === '*') {
      const end = sourceText.indexOf('*/', index + 2)
      if (end === -1) throw new Error('Generated declaration contains an unterminated comment')
      index = end + 2
      continue
    }
    if (character !== '/' || next !== '/') {
      index += 1
      continue
    }

    const lineEnd = sourceText.indexOf('\n', index + 2)
    const end = lineEnd === -1 ? sourceText.length : lineEnd
    const lineStart = sourceText.lastIndexOf('\n', index - 1) + 1
    const leadingText = sourceText.slice(lineStart, index)
    const comment = sourceText.slice(index, end)
    const match = /^\/\/\/\s*<reference\b([^>]*)\/?>\s*$/.exec(comment)
    if (leadingText.trim() === '' && match !== null) {
      directives.push(parseReferenceDirectiveAttributes(match[1]))
    }
    index = end
  }

  return directives
}

function parseReferenceDirectiveAttributes(sourceText) {
  const attributes = []
  const attributePattern = /([A-Za-z][\w-]*)\s*=\s*(['"])(.*?)\2/g
  for (const attribute of sourceText.matchAll(attributePattern)) {
    attributes.push({ name: attribute[1], value: attribute[3] })
  }
  attributes.sort((left, right) => (
    left.name.localeCompare(right.name) || left.value.localeCompare(right.value)
  ))
  return { attributes }
}

function collectSemanticJsDocTags(comment) {
  return [...comment.matchAll(/@(deprecated)\b/g)]
    .map((match) => match[1])
    .sort((left, right) => left.localeCompare(right))
}

function collectOptionalCompatibilityFields(packageManifest) {
  const fields = {}
  if (packageManifest.dependencies !== undefined) {
    fields.dependencies = canonicalizeUnorderedObject(packageManifest.dependencies)
  }
  if (packageManifest.optionalDependencies !== undefined) {
    fields.optionalDependencies = canonicalizeUnorderedObject(
      packageManifest.optionalDependencies
    )
  }
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
