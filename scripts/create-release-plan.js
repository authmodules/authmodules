import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  assertReleasePleaseManifest,
  isExactVersion,
  packageRepositories
} from './release-manifest.js'

const execFileAsync = promisify(execFile)
const baseSha = requiredSha('AUTHMODULES_BASE_SHA')
const outputPath = process.env.GITHUB_OUTPUT
const root = path.resolve(import.meta.dirname, '..')
const currentManifest = parseManifest(
  await readFile(path.join(root, '.release-please-manifest.json'), 'utf8'),
  'current release manifest'
)
const previousManifest = parseManifest(
  await gitShow(baseSha, '.release-please-manifest.json'),
  'previous release manifest'
)
const knownPaths = new Map(
  packageRepositories.map((name) => [`packages/${name}`, name])
)

assertReleasePleaseManifest(currentManifest, { label: 'Current release manifest' })
assertReleasePleaseManifest(previousManifest, {
  label: 'Previous release manifest'
})

const changed = []
for (const [packagePath, name] of knownPaths) {
  const version = currentManifest[packagePath]
  if (version === previousManifest[packagePath]) continue
  if (!isExactVersion(version)) {
    throw new Error(`${packagePath} must have an exact released version`)
  }
  const packageManifest = JSON.parse(
    await readFile(path.join(root, packagePath, 'package.json'), 'utf8')
  )
  if (packageManifest.name !== `@authmodules/${name}`) {
    throw new Error(`${packagePath} package name does not match its workspace`)
  }
  if (packageManifest.version !== version) {
    throw new Error(`${packagePath} version does not match the release manifest`)
  }
  if (
    packageManifest.repository?.url !== 'git+https://github.com/authmodules/authmodules.git'
    || packageManifest.repository?.directory !== packagePath
  ) {
    throw new Error(`${packagePath} repository metadata is not monorepo-safe`)
  }
  changed.push({
    name,
    package: packageManifest.name,
    path: packagePath,
    version
  })
}

if (changed.length === 0) {
  throw new Error('Release manifest changed without any package version changes')
}

const matrix = JSON.stringify({ include: changed })
if (outputPath) {
  await appendFile(outputPath, `matrix=${matrix}\n`)
  await appendFile(outputPath, `count=${changed.length}\n`)
}

console.log(`Release plan contains ${changed.length} package(s)`)

function requiredSha(name) {
  const value = process.env[name]
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    throw new Error(`${name} must be a full lowercase commit SHA`)
  }
  return value
}

function parseManifest(source, label) {
  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

async function gitShow(ref, filePath) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'show', `${ref}:${filePath}`],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    )
    return stdout
  } catch (error) {
    throw new Error(`Unable to read ${filePath} at ${ref}`)
  }
}
