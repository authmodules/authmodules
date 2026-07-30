import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createPackageProvenance } from './package-provenance.js'
import { createPackageSbom } from './package-sbom.js'
import { isExactIntegrity, isExactVersion } from './release-manifest.js'

const execFileAsync = promisify(execFile)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packageDirectory = process.env.AUTHMODULES_PACKAGE_DIRECTORY
const contractsDirectory = process.env.AUTHMODULES_CONTRACTS_DIRECTORY
const evidenceDirectory = process.env.AUTHMODULES_EVIDENCE_DIRECTORY
const expectedIntegrity = process.env.AUTHMODULES_EXPECTED_INTEGRITY
const outputPath = process.env.GITHUB_OUTPUT
const releaseSha = requiredSha('AUTHMODULES_RELEASE_SHA')
const workflowSha = requiredSha('AUTHMODULES_WORKFLOW_SHA')

if (typeof packageDirectory !== 'string' || packageDirectory.length === 0) {
  throw new Error('AUTHMODULES_PACKAGE_DIRECTORY is required')
}
if (typeof contractsDirectory !== 'string' || contractsDirectory.length === 0) {
  throw new Error('AUTHMODULES_CONTRACTS_DIRECTORY is required')
}
if (typeof evidenceDirectory !== 'string' || evidenceDirectory.length === 0) {
  throw new Error('AUTHMODULES_EVIDENCE_DIRECTORY is required')
}
if (expectedIntegrity !== undefined && !isExactIntegrity(expectedIntegrity)) {
  throw new Error('AUTHMODULES_EXPECTED_INTEGRITY must be an exact SHA-512 digest')
}
if (typeof outputPath !== 'string' || outputPath.length === 0) {
  throw new Error('GITHUB_OUTPUT is required')
}

const packageRoot = path.resolve(process.cwd(), packageDirectory)
const contractsRoot = path.resolve(process.cwd(), contractsDirectory)
const evidenceRoot = path.resolve(evidenceDirectory)
const packageManifest = await readManifest(packageRoot)
const contractsManifest = await readManifest(contractsRoot)

assertPackageManifest(packageManifest)
assertPackageManifest(contractsManifest)
assertSupportedDependencies(packageManifest)
await mkdir(evidenceRoot, { recursive: true })

const packResult = await packPackage(packageRoot, evidenceRoot)
if (expectedIntegrity !== undefined && packResult.integrity !== expectedIntegrity) {
  throw new Error(`${packageManifest.name}@${packageManifest.version} tarball does not match the release plan integrity`)
}

const tarballPath = path.join(evidenceRoot, packResult.filename)
const evidencePath = path.join(
  evidenceRoot,
  `${packageManifest.name.slice('@authmodules/'.length)}-${packageManifest.version}.evidence.json`
)
const sbomPath = path.join(
  evidenceRoot,
  `${packageManifest.name.slice('@authmodules/'.length)}-${packageManifest.version}.cdx.json`
)
const provenancePath = path.join(
  evidenceRoot,
  `${packageManifest.name.slice('@authmodules/'.length)}-${packageManifest.version}.provenance.json`
)
await writeFile(
  sbomPath,
  `${JSON.stringify(
    createPackageSbom(packageManifest, contractsManifest, packResult.integrity),
    null,
    2
  )}\n`
)
await writeFile(
  provenancePath,
  `${JSON.stringify(createPackageProvenance(packageManifest, {
    eventName: required('GITHUB_EVENT_NAME'),
    releaseSha,
    repository: required('GITHUB_REPOSITORY'),
    runAttempt: required('GITHUB_RUN_ATTEMPT'),
    runId: required('GITHUB_RUN_ID'),
    serverUrl: required('GITHUB_SERVER_URL'),
    workflowRef: required('GITHUB_WORKFLOW_REF'),
    workflowSha
  }), null, 2)}\n`
)
await writeFile(evidencePath, `${JSON.stringify({
  schemaVersion: 1,
  package: packageManifest.name,
  version: packageManifest.version,
  integrity: packResult.integrity,
  tarball: packResult.filename,
  sbom: path.basename(sbomPath),
  provenance: path.basename(provenancePath)
}, null, 2)}\n`)
await appendFile(outputPath, `package_tarball=${tarballPath}\n`)
await appendFile(outputPath, `sbom_path=${sbomPath}\n`)
await appendFile(outputPath, `provenance_path=${provenancePath}\n`)
await appendFile(outputPath, `evidence_path=${evidencePath}\n`)
await appendFile(outputPath, `package_integrity=${packResult.integrity}\n`)

console.log(`${packageManifest.name}@${packageManifest.version} release evidence prepared`)

async function readManifest(directory) {
  return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
}

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredSha(name) {
  const value = required(name)
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} must be a full lowercase commit SHA`)
  }
  return value
}

function assertPackageManifest(manifest) {
  if (
    typeof manifest.name !== 'string'
    || !/^@authmodules\/[a-z0-9-]+$/.test(manifest.name)
    || !isExactVersion(manifest.version)
  ) {
    throw new Error('Package name and exact version are required')
  }
}

function assertSupportedDependencies(manifest) {
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (manifest[field] !== undefined && Object.keys(manifest[field]).length > 0) {
      throw new Error(`${manifest.name} ${field} must be represented before release evidence can be generated`)
    }
  }
  const peers = manifest.peerDependencies ?? {}
  const unsupportedPeers = Object.keys(peers).filter((name) => name !== '@authmodules/contracts')
  if (unsupportedPeers.length > 0) {
    throw new Error(`${manifest.name} has unsupported peer dependencies: ${unsupportedPeers.join(', ')}`)
  }
}

async function packPackage(directory, destination) {
  const { stdout } = await execFileAsync(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    { cwd: directory, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  )
  const result = JSON.parse(stdout)
  const packed = result?.[0]
  if (
    result.length !== 1
    || typeof packed?.filename !== 'string'
    || !isExactIntegrity(packed.integrity)
  ) {
    throw new Error('npm pack did not produce one valid package tarball')
  }
  return packed
}
