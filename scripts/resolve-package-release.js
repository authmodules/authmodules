import { appendFile, readFile } from 'node:fs/promises'
import { isExactVersion, parseReleaseManifest } from './release-manifest.js'

const release = process.env.AUTHMODULES_RELEASE_ID
const repository = process.env.AUTHMODULES_PACKAGE_REPOSITORY
const packageKey = process.env.AUTHMODULES_PACKAGE_KEY
const outputPath = process.env.GITHUB_OUTPUT

if (!isExactVersion(release)) {
  throw new Error('AUTHMODULES_RELEASE_ID must be an exact release version')
}
if (typeof repository !== 'string' || !/^authmodules\/[a-z0-9-]+$/.test(repository)) {
  throw new Error('AUTHMODULES_PACKAGE_REPOSITORY must be an AuthModules repository')
}
if (typeof packageKey !== 'string') {
  throw new Error('AUTHMODULES_PACKAGE_KEY is required')
}
if (outputPath === undefined || outputPath.length === 0) {
  throw new Error('GITHUB_OUTPUT is required')
}

const manifest = parseReleaseManifest(
  JSON.parse(await readFile(new URL(`../releases/${release}.json`, import.meta.url), 'utf8')),
  release
)
const packageRelease = manifest.packages[packageKey]
if (packageRelease === undefined) {
  throw new Error(`${packageKey} is not part of release ${release}`)
}
if (packageRelease.repository !== repository) {
  throw new Error(`${packageKey} release entry does not belong to ${repository}`)
}

const contractsRelease = manifest.packages.contracts
const outputs = {
  package_tag: packageRelease.tag,
  package_revision: packageRelease.revision,
  package_version: packageRelease.version,
  package_integrity: packageRelease.integrity,
  contracts_tag: contractsRelease.tag,
  contracts_revision: contractsRelease.revision,
  contracts_version: contractsRelease.version
}
await appendFile(
  outputPath,
  `${Object.entries(outputs).map(([name, value]) => `${name}=${value}`).join('\n')}\n`
)

console.log(`${repository}@${packageRelease.version} resolved from release plan ${release}`)
