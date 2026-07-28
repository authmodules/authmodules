import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { packageRepositories } from './release-manifest.js'

const requiredRepositories = packageRepositories

const root = new URL('../..', import.meta.url)
const rootPath = fileURLToPath(root)

await assertNoWorkspaceArtifacts(root)

for (const repository of requiredRepositories) {
  await access(new URL(`${repository}/.git`, root))
  await access(new URL(`${repository}/tests`, root))
  const manifestUrl = new URL(`${repository}/package.json`, root)
  await access(manifestUrl)
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  if (!manifest.scripts?.test?.includes('tests')) {
    throw new Error(`${repository} must run tests from tests/`)
  }
  if (!manifest.scripts.test.includes('.ts')) {
    throw new Error(`${repository} must run TypeScript tests from tests/`)
  }
  if (!manifest.repository?.url?.includes(`authmodules/${repository}.git`)) {
    throw new Error(`${repository} must declare its GitHub repository metadata`)
  }
  if (manifest.publishConfig?.registry !== 'https://npm.pkg.github.com') {
    throw new Error(`${repository} must declare GitHub Packages as its publish registry`)
  }
  if (manifest.scripts?.prepack !== 'npm run build') {
    throw new Error(`${repository} must build before pack`)
  }
  await assertNoAnyTypes(repository)
  if (repository !== 'contracts') {
    await assertRuntimeTypeScriptPackage(repository, manifest)
  }
}

async function assertNoAnyTypes(repository) {
  const sourceRoot = new URL(`${repository}/src/`, root)
  const files = await collectTypeScriptFiles(sourceRoot)

  for (const fileUrl of files) {
    const filePath = fileURLToPath(fileUrl)
    if (repository !== 'contracts' && filePath.endsWith('.d.ts')) {
      throw new Error(`${path.relative(rootPath, filePath)} must be generated from TypeScript source`)
    }
    const sourceText = await readFile(fileUrl, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    assertImportsFirst(sourceFile, fileUrl)
    let containsAny = false
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) containsAny = true
      if (!containsAny) ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (containsAny) {
      throw new Error(`${path.relative(rootPath, filePath)} must not use the any type`)
    }
  }
}

function assertImportsFirst(sourceFile, fileUrl) {
  let sourceDeclarationSeen = false
  for (const statement of sourceFile.statements) {
    const isImport = ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)
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
  const entrypointUrl = new URL(`${repository}/src/index.ts`, root)
  await access(entrypointUrl)
  await access(new URL(`${repository}/.github/workflows/check.yml`, root))

  const entrypoint = await readFile(entrypointUrl, 'utf8')
  const entrypointSource = ts.createSourceFile(
    fileURLToPath(entrypointUrl),
    entrypoint,
    ts.ScriptTarget.Latest,
    true
  )
  const explicitReexports = entrypointSource.statements.length > 0
    && entrypointSource.statements.every((statement) => (
      ts.isExportDeclaration(statement)
      && statement.exportClause !== undefined
      && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.length > 0
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.startsWith('./')
      && statement.moduleSpecifier.text.endsWith('.ts')
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

  const tsconfig = JSON.parse(await readFile(new URL(`${repository}/tsconfig.json`, root), 'utf8'))
  if (tsconfig.compilerOptions?.strict !== true || 'noCheck' in (tsconfig.compilerOptions ?? {})) {
    throw new Error(`${repository} must use strict TypeScript without noCheck`)
  }
  if (tsconfig.compilerOptions?.noUnusedLocals !== true) {
    throw new Error(`${repository} must reject unused local declarations and imports`)
  }
  if (tsconfig.compilerOptions?.rewriteRelativeImportExtensions !== true) {
    throw new Error(`${repository} must rewrite source TypeScript specifiers for ESM output`)
  }
}
