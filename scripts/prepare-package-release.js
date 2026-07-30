import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createPackageSbom } from './package-sbom.js'
import { isExactIntegrity, isExactVersion } from './release-manifest.js'

const execFileAsync = promisify(execFile)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packageDirectory = required('AUTHMODULES_PACKAGE_DIRECTORY')
const outputDirectory = required('AUTHMODULES_OUTPUT_DIRECTORY')
const outputPath = required('GITHUB_OUTPUT')
const packageRoot = path.resolve(packageDirectory)
const contractsRoot = path.resolve('packages/contracts')
const outputRoot = path.resolve(outputDirectory)
const packageManifest = await readManifest(packageRoot)
const contractsManifest = await readManifest(contractsRoot)

assertPackageManifest(packageManifest)
assertPackageManifest(contractsManifest)
await mkdir(outputRoot, { recursive: true })

const packed = await packPackage(packageRoot, outputRoot)
const tarballPath = path.join(outputRoot, packed.filename)
const sbomPath = path.join(
  outputRoot,
  `${packageManifest.name.slice('@authmodules/'.length)}-${packageManifest.version}.cdx.json`
)

await writeFile(
  sbomPath,
  `${JSON.stringify(
    createPackageSbom(packageManifest, contractsManifest, packed.integrity),
    null,
    2
  )}\n`
)
await appendFile(outputPath, `package_tarball=${tarballPath}\n`)
await appendFile(outputPath, `package_integrity=${packed.integrity}\n`)
await appendFile(outputPath, `sbom_path=${sbomPath}\n`)

console.log(`${packageManifest.name}@${packageManifest.version} prepared`)

async function readManifest(directory) {
  return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
}

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
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
