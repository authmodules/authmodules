import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isExactIntegrity, isExactVersion } from './release-manifest.js'

const execFileAsync = promisify(execFile)
const mode = process.env.AUTHMODULES_PUBLICATION_MODE
const packageDirectory = process.env.AUTHMODULES_PACKAGE_DIRECTORY
const packageTarball = process.env.AUTHMODULES_PACKAGE_TARBALL
const expectedIntegrity = process.env.AUTHMODULES_EXPECTED_INTEGRITY
const outputPath = process.env.GITHUB_OUTPUT
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const registry = 'https://npm.pkg.github.com'

if (mode !== 'resolve' && mode !== 'verify') {
  throw new Error('AUTHMODULES_PUBLICATION_MODE must be resolve or verify')
}
if (typeof packageDirectory !== 'string') {
  throw new Error('AUTHMODULES_PACKAGE_DIRECTORY is required')
}
if (typeof packageTarball !== 'string' || packageTarball.length === 0) {
  throw new Error('AUTHMODULES_PACKAGE_TARBALL is required')
}
if (!isExactIntegrity(expectedIntegrity)) {
  throw new Error('AUTHMODULES_EXPECTED_INTEGRITY must be an exact SHA-512 digest')
}
if (mode === 'resolve' && (outputPath === undefined || outputPath.length === 0)) {
  throw new Error('GITHUB_OUTPUT is required in resolve mode')
}

const sourceRoot = path.resolve(process.cwd(), packageDirectory)
const packageManifest = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'))
if (
  typeof packageManifest.name !== 'string'
  || !/^@authmodules\/[a-z0-9-]+$/.test(packageManifest.name)
  || !isExactVersion(packageManifest.version)
) {
  throw new Error('Package name and exact version are required')
}

const localIntegrity = await resolveLocalIntegrity(path.resolve(packageTarball))
if (localIntegrity !== expectedIntegrity) {
  throw new Error(`${packageManifest.name}@${packageManifest.version} does not match the release plan integrity`)
}
const packageSpec = `${packageManifest.name}@${packageManifest.version}`

if (mode === 'resolve') {
  const remoteIntegrity = await resolveRemoteIntegrity(packageSpec, true)
  if (remoteIntegrity !== undefined && remoteIntegrity !== localIntegrity) {
    throw new Error(`${packageSpec} already exists with different package contents`)
  }
  const publish = remoteIntegrity === undefined
  await appendFile(outputPath, `publish=${publish}\n`)
  console.log(publish
    ? `${packageSpec} is not published yet`
    : `${packageSpec} is already published with matching contents`)
} else {
  let remoteIntegrity
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    remoteIntegrity = await resolveRemoteIntegrity(packageSpec, true)
    if (remoteIntegrity !== undefined) break
    if (attempt < 6) {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
  if (remoteIntegrity === undefined) {
    throw new Error(`${packageSpec} was not visible in GitHub Packages after bounded retries`)
  }
  if (remoteIntegrity !== localIntegrity) {
    throw new Error(`${packageSpec} registry integrity does not match the verified package`)
  }
  console.log(`${packageSpec} registry integrity verified`)
}

async function resolveLocalIntegrity(tarballPath) {
  const digest = createHash('sha512').update(await readFile(tarballPath)).digest('base64')
  const integrity = `sha512-${digest}`
  if (!isExactIntegrity(integrity)) throw new Error('Package tarball has an invalid SHA-512 digest')
  return integrity
}

async function resolveRemoteIntegrity(packageSpec, allowMissing) {
  try {
    const { stdout } = await execFileAsync(
      npm,
      ['view', packageSpec, 'dist.integrity', '--json', `--registry=${registry}`],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    )
    const integrity = JSON.parse(stdout)
    if (typeof integrity !== 'string') {
      throw new Error(`${packageSpec} registry metadata does not contain one integrity value`)
    }
    return integrity
  } catch (error) {
    const diagnostic = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
    if (allowMissing && /(?:^|\s)E404(?:\s|$)|404 Not Found/.test(diagnostic)) {
      return undefined
    }
    if (error instanceof Error && error.message.includes('registry metadata')) {
      throw error
    }
    throw new Error(`Unable to read ${packageSpec} metadata from GitHub Packages`)
  }
}
