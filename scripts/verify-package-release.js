import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isExactVersion, parseReleaseManifest } from './release-manifest.js'

const execFileAsync = promisify(execFile)
const release = process.env.AUTHMODULES_RELEASE_ID
const repository = process.env.AUTHMODULES_PACKAGE_REPOSITORY
const packageKey = process.env.AUTHMODULES_PACKAGE_KEY
const packageDirectory = process.env.AUTHMODULES_PACKAGE_DIRECTORY
const contractsDirectory = process.env.AUTHMODULES_CONTRACTS_DIRECTORY

if (!isExactVersion(release)) {
  throw new Error('AUTHMODULES_RELEASE_ID must be an exact release version')
}
if (typeof repository !== 'string' || !/^authmodules\/[a-z0-9-]+$/.test(repository)) {
  throw new Error('AUTHMODULES_PACKAGE_REPOSITORY must be an AuthModules repository')
}
if (typeof packageKey !== 'string' || typeof packageDirectory !== 'string') {
  throw new Error('Package key and directory are required')
}

const manifest = parseReleaseManifest(
  JSON.parse(await readFile(new URL(`../releases/${release}.json`, import.meta.url), 'utf8')),
  release
)
const packageRelease = manifest.packages[packageKey]
if (packageRelease === undefined || packageRelease.repository !== repository) {
  throw new Error(`${packageKey} is not the ${repository} entry in release ${release}`)
}

await verifySource(packageKey, packageDirectory, packageRelease)
if (packageKey !== 'contracts') {
  if (typeof contractsDirectory !== 'string') {
    throw new Error('AUTHMODULES_CONTRACTS_DIRECTORY is required for runtime packages')
  }
  await verifySource('contracts', contractsDirectory, manifest.packages.contracts)
}

console.log(`${repository} source matches immutable release plan ${release}`)

async function verifySource(key, directory, expected) {
  const sourceRoot = path.resolve(process.cwd(), directory)
  const packageManifest = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(path.join(sourceRoot, 'package-lock.json'), 'utf8'))
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8'
  })
  const actualRevision = stdout.trim()

  assert(actualRevision === expected.revision, `${key} checkout does not match its release revision`)
  assert(packageManifest.name === `@authmodules/${key}`, `${key} package name does not match its release entry`)
  assert(packageManifest.version === expected.version, `${key} package version does not match its release entry`)
  assert(lock.version === expected.version, `${key} lockfile version does not match its release entry`)
  assert(lock.packages?.['']?.version === expected.version, `${key} root lockfile version does not match its release entry`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
