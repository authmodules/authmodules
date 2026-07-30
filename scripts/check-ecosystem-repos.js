import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { packageRepositories } from './release-manifest.js'

const requiredRepositories = packageRepositories

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const rootManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const expectedWorkspaces = requiredRepositories.map((repository) => `packages/${repository}`)
if (JSON.stringify(rootManifest.workspaces) !== JSON.stringify(expectedWorkspaces)) {
  throw new Error('Root workspaces must list every package exactly once in the canonical order')
}

await access(new URL('package-lock.json', root))
await assertNoWorkspaceArtifacts(root)

for (const repository of requiredRepositories) {
  const packageUrl = new URL(`packages/${repository}/`, root)
  await access(new URL('tests/', packageUrl))
  const manifestUrl = new URL('package.json', packageUrl)
  await access(manifestUrl)
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  if (manifest.name !== `@authmodules/${repository}`) {
    throw new Error(`${repository} must retain its public package name`)
  }
  if (!manifest.scripts?.test?.includes('tests')) {
    throw new Error(`${repository} must run tests from tests/`)
  }
  if (!manifest.scripts.test.includes('.ts')) {
    throw new Error(`${repository} must run TypeScript tests from tests/`)
  }
  if (
    manifest.repository?.url !== 'git+https://github.com/authmodules/authmodules.git'
    || manifest.repository?.directory !== `packages/${repository}`
  ) {
    throw new Error(`${repository} must point to its monorepo directory`)
  }
  if (manifest.bugs?.url !== 'https://github.com/authmodules/authmodules/issues') {
    throw new Error(`${repository} must use the monorepo issue tracker`)
  }
  if (
    manifest.homepage
    !== `https://github.com/authmodules/authmodules/tree/main/packages/${repository}#readme`
  ) {
    throw new Error(`${repository} must use its monorepo package homepage`)
  }
  if (manifest.publishConfig?.registry !== 'https://npm.pkg.github.com') {
    throw new Error(`${repository} must declare GitHub Packages as its publish registry`)
  }
  if (manifest.scripts?.prepack !== 'npm run build') {
    throw new Error(`${repository} must build before pack`)
  }
  if (
    manifest.scripts?.['api:check'] !== 'node ../../scripts/check-package-api.js'
    || manifest.scripts?.['api:update']
      !== 'npm run build && node ../../scripts/check-package-api.js --write'
  ) {
    throw new Error(`${repository} must use the root public API checker`)
  }
  await assertNoNestedRepositoryArtifacts(packageUrl)
  await assertNoAnyTypes(repository)
  if (repository !== 'contracts') {
    await assertRuntimeTypeScriptPackage(repository, manifest)
  }
}

async function assertNoAnyTypes(repository) {
  const sourceRoot = new URL(`packages/${repository}/src/`, root)
  const files = await collectTypeScriptFiles(sourceRoot)

  for (const fileUrl of files) {
    const filePath = fileURLToPath(fileUrl)
    if (repository !== 'contracts' && filePath.endsWith('.d.ts')) {
      throw new Error(`${path.relative(rootPath, filePath)} must be generated from TypeScript source`)
    }
    const sourceText = await readFile(fileUrl, 'utf8')
    const program = parseTypeScript(sourceText, filePath)
    assertImportsFirst(program.body, fileUrl)
    if (containsNodeType(program, 'TSAnyKeyword')) {
      throw new Error(`${path.relative(rootPath, filePath)} must not use the any type`)
    }
  }
}

function assertImportsFirst(statements, fileUrl) {
  let sourceDeclarationSeen = false
  for (const statement of statements) {
    const isImport = statement.type === 'ImportDeclaration'
      || statement.type === 'TSImportEqualsDeclaration'
    if (isImport && sourceDeclarationSeen) {
      throw new Error(`${path.relative(rootPath, fileURLToPath(fileUrl))} must keep imports before declarations`)
    }
    if (!isImport) sourceDeclarationSeen = true
  }
}

async function collectTypeScriptFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directoryUrl)
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(entryUrl))
    } else if (entry.name.endsWith('.ts')) {
      files.push(entryUrl)
    }
  }
  return files
}

console.log('Ecosystem repositories present')

async function assertNoWorkspaceArtifacts(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.idea' || entry.name === 'node_modules') {
      continue
    }

    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directoryUrl)
    const relativePath = path.relative(rootPath, fileURLToPath(entryUrl))

    if (isForbiddenWorkspaceArtifact(entry.name)) {
      throw new Error(`${relativePath} must not remain in the AuthModules workspace`)
    }

    if (entry.isDirectory()) {
      await assertNoWorkspaceArtifacts(entryUrl)
    }
  }
}

function isForbiddenWorkspaceArtifact(name) {
  return name === '.DS_Store'
    || name === 'CHANGELOG-v13.md'
    || name === 'build.mjs'
    || name === 'public-types.ts'
    || name === 'tsc-check.ts'
    || name === 'tsconfig.speccheck.json'
    || name === 'tsconfig.types.json'
    || name.endsWith('.old-delete-candidate')
    || name.endsWith('.tgz')
    || name.endsWith('.zip')
}

async function assertRuntimeTypeScriptPackage(repository, manifest) {
  const entrypointUrl = new URL(`packages/${repository}/src/index.ts`, root)
  await access(entrypointUrl)

  const entrypoint = await readFile(entrypointUrl, 'utf8')
  const entrypointProgram = parseTypeScript(entrypoint, fileURLToPath(entrypointUrl))
  const explicitReexports = entrypointProgram.body.length > 0
    && entrypointProgram.body.every((statement) => (
      statement.type === 'ExportNamedDeclaration'
      && statement.declaration === null
      && statement.specifiers.length > 0
      && statement.specifiers.every((specifier) => specifier.type === 'ExportSpecifier')
      && statement.source?.type === 'StringLiteral'
      && statement.source.value.startsWith('./')
      && statement.source.value.endsWith('.ts')
    ))
  if (!explicitReexports) {
    throw new Error(`${repository} src/index.ts must contain only explicit TypeScript re-exports`)
  }

  if (manifest.main !== './dist/index.js') {
    throw new Error(`${repository} must expose dist/index.js as main`)
  }
  if (manifest.types !== './dist/index.d.ts') {
    throw new Error(`${repository} must expose dist/index.d.ts as top-level types`)
  }
  if (manifest.exports?.['.']?.import !== './dist/index.js') {
    throw new Error(`${repository} must publish runtime import from dist/index.js`)
  }
  if (manifest.exports?.['.']?.types !== './dist/index.d.ts') {
    throw new Error(`${repository} must publish public types from dist/index.d.ts`)
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes('dist')) {
    throw new Error(`${repository} must publish the dist directory`)
  }
  if (manifest.files.some((entry) => entry === 'src' || entry.startsWith('src/'))) {
    throw new Error(`${repository} must not publish source files`)
  }
  if (manifest.scripts?.build !== 'tsc -b --clean && tsc -p tsconfig.json') {
    throw new Error(`${repository} must clean and compile with standard TypeScript commands`)
  }
  if (!manifest.scripts?.smoke?.includes('dist/index.js') && !manifest.scripts?.['smoke:dist']?.includes('dist/index.js')) {
    throw new Error(`${repository} must smoke test dist/index.js`)
  }

  const tsconfig = JSON.parse(
    await readFile(new URL(`packages/${repository}/tsconfig.json`, root), 'utf8')
  )
  if (tsconfig.compilerOptions?.strict !== true || 'noCheck' in (tsconfig.compilerOptions ?? {})) {
    throw new Error(`${repository} must use strict TypeScript without noCheck`)
  }
  if (tsconfig.compilerOptions?.noUnusedLocals !== true) {
    throw new Error(`${repository} must reject unused local declarations and imports`)
  }
  if (tsconfig.compilerOptions?.rewriteRelativeImportExtensions !== true) {
    throw new Error(`${repository} must rewrite source TypeScript specifiers for ESM output`)
  }
  if (tsconfig.compilerOptions?.rootDir !== './src') {
    throw new Error(`${repository} must declare the TypeScript 7 source root explicitly`)
  }
}

async function assertNoNestedRepositoryArtifacts(packageUrl) {
  const forbidden = [
    '.git',
    '.github',
    'package-lock.json',
    'scripts/check-package-api.js'
  ]
  for (const relativePath of forbidden) {
    try {
      await access(new URL(relativePath, packageUrl))
      throw new Error(
        `${path.relative(rootPath, fileURLToPath(new URL(relativePath, packageUrl)))} `
        + 'must not exist in a workspace package'
      )
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function parseTypeScript(sourceText, filePath) {
  return parse(sourceText, {
    sourceFilename: filePath,
    sourceType: 'module',
    plugins: [[
      'typescript',
      { dts: filePath.endsWith('.d.ts') }
    ]]
  }).program
}

function containsNodeType(rootNode, expectedType) {
  const queue = [rootNode]
  while (queue.length > 0) {
    const value = queue.pop()
    if (value === null || typeof value !== 'object') continue
    if (value.type === expectedType) return true
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        queue.push(...child)
      } else if (child !== null && typeof child === 'object') {
        queue.push(child)
      }
    }
  }
  return false
}
