import { appendFile, readFile } from 'node:fs/promises'
import { isExactVersion, parseReleaseManifest, workflowOutputs } from './release-manifest.js'

const release = process.env.AUTHMODULES_RELEASE_ID
if (!isExactVersion(release)) {
  throw new Error('AUTHMODULES_RELEASE_ID must be an exact release version')
}
if (process.env.AUTHMODULES_RELEASE_REF !== `refs/tags/release-plan/v${release}`) {
  throw new Error('Release verification must run from the matching immutable release-plan tag')
}

const manifestUrl = new URL(`../releases/${release}.json`, import.meta.url)
const manifest = parseReleaseManifest(
  JSON.parse(await readFile(manifestUrl, 'utf8')),
  release
)
const outputPath = process.env.GITHUB_OUTPUT
if (outputPath === undefined || outputPath.length === 0) {
  throw new Error('GITHUB_OUTPUT is required')
}

const output = Object.entries(workflowOutputs(manifest))
  .map(([name, value]) => `${name}=${value}`)
  .join('\n')
await appendFile(outputPath, `${output}\n`)

console.log(`Release manifest ${release} resolved`)
