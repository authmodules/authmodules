import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isExactIntegrity, isExactVersion } from './release-manifest.js'

const execFileAsync = promisify(execFile)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packageDirectory = process.env.AUTHMODULES_PACKAGE_DIRECTORY
const contractsDirectory = process.env.AUTHMODULES_CONTRACTS_DIRECTORY
const evidenceDirectory = process.env.AUTHMODULES_EVIDENCE_DIRECTORY
const expectedIntegrity = process.env.AUTHMODULES_EXPECTED_INTEGRITY
const outputPath = process.env.GITHUB_OUTPUT

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
await writeFile(sbomPath, `${JSON.stringify(createSbom(packageManifest, contractsManifest), null, 2)}\n`)
await writeFile(evidencePath, `${JSON.stringify({
  schemaVersion: 1,
  package: packageManifest.name,
  version: packageManifest.version,
  integrity: packResult.integrity,
  tarball: packResult.filename,
  sbom: path.basename(sbomPath)
}, null, 2)}\n`)
await appendFile(outputPath, `package_tarball=${tarballPath}\n`)
await appendFile(outputPath, `sbom_path=${sbomPath}\n`)
await appendFile(outputPath, `evidence_path=${evidencePath}\n`)
await appendFile(outputPath, `package_integrity=${packResult.integrity}\n`)

console.log(`${packageManifest.name}@${packageManifest.version} release evidence prepared`)

async function readManifest(directory) {
  return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
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

function createSbom(manifest, contractsManifest) {
  const rootRef = packagePurl(manifest)
  const contractRange = manifest.peerDependencies?.['@authmodules/contracts']
  const includesContracts = contractRange !== undefined
  const contractsRef = packagePurl(contractsManifest)

  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: createComponent(manifest, rootRef)
    },
    components: includesContracts
      ? [{
          ...createComponent(contractsManifest, contractsRef),
          scope: 'required',
          properties: [{
            name: 'authmodules:peerDependencyRange',
            value: contractRange
          }]
        }]
      : [],
    dependencies: [
      {
        ref: rootRef,
        dependsOn: includesContracts ? [contractsRef] : []
      },
      ...(includesContracts ? [{ ref: contractsRef, dependsOn: [] }] : [])
    ]
  }
}

function createComponent(manifest, bomRef) {
  return {
    type: 'library',
    'bom-ref': bomRef,
    group: 'authmodules',
    name: manifest.name.slice('@authmodules/'.length),
    version: manifest.version,
    description: manifest.description,
    licenses: [{
      license: {
        id: manifest.license
      }
    }],
    purl: bomRef
  }
}

function packagePurl(manifest) {
  return `pkg:npm/%40authmodules/${manifest.name.slice('@authmodules/'.length)}@${manifest.version}`
}
