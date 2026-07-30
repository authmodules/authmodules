import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { shouldPublishReleaseManifest } from './release-manifest.js'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const outputPath = process.env.GITHUB_OUTPUT
if (!outputPath) throw new Error('GITHUB_OUTPUT is required')
const baseSha = process.env.AUTHMODULES_BASE_SHA
if (!/^[0-9a-f]{40}$/.test(baseSha ?? '')) {
  throw new Error('AUTHMODULES_BASE_SHA must be a full lowercase commit SHA')
}

const manifest = JSON.parse(
  await readFile(path.join(root, '.release-please-manifest.json'), 'utf8')
)
const previousManifest = await readManifestAtBase(baseSha)

const release = shouldPublishReleaseManifest(previousManifest, manifest)
await appendFile(outputPath, `release=${release}\n`)
console.log(release
  ? 'Release manifest contains package versions'
  : 'Empty bootstrap manifest does not publish packages')

async function readManifestAtBase(ref) {
  if (ref === '0'.repeat(40)) return {}
  const filePath = '.release-please-manifest.json'
  const { stdout: listed } = await execFileAsync(
    'git',
    ['-C', root, 'ls-tree', '--name-only', ref, '--', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  if (listed.trim() === '') return {}
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, 'show', `${ref}:${filePath}`],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  return JSON.parse(stdout)
}
