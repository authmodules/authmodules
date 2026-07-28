import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  isExactVersion,
  packageRepositories,
  parseReleaseManifest
} from './release-manifest.js'

const execFileAsync = promisify(execFile)
const release = process.env.AUTHMODULES_RELEASE_ID
if (!isExactVersion(release)) {
  throw new Error('AUTHMODULES_RELEASE_ID must be an exact release version')
}

const manifestUrl = new URL(`../releases/${release}.json`, import.meta.url)
const manifest = parseReleaseManifest(
  JSON.parse(await readFile(manifestUrl, 'utf8')),
  release
)
const workspaceRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

for (const repository of packageRepositories) {
  const repositoryPath = path.join(workspaceRoot, repository)
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryPath,
    encoding: 'utf8'
  })
  const actualRevision = stdout.trim()
  const expectedRevision = manifest.packages[repository].revision
  if (actualRevision !== expectedRevision) {
    throw new Error(`${repository} resolved ${actualRevision} instead of ${expectedRevision}`)
  }
}

console.log(`Release workspace ${release} matches its manifest`)
