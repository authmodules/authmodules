import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outputPath = process.env.GITHUB_OUTPUT
if (!outputPath) throw new Error('GITHUB_OUTPUT is required')

const manifest = JSON.parse(
  await readFile(path.join(root, '.release-please-manifest.json'), 'utf8')
)
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  throw new Error('Release Please manifest must be an object')
}

const release = Object.keys(manifest).length > 0
await appendFile(outputPath, `release=${release}\n`)
console.log(release
  ? 'Release manifest contains package versions'
  : 'Empty bootstrap manifest does not publish packages')
