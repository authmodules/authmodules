import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const eventName = required('GITHUB_EVENT_NAME')
const currentSha = requiredSha('GITHUB_SHA')
const outputPath = required('GITHUB_OUTPUT')
const checkedOutSha = (await git(['rev-parse', 'HEAD'])).trim()

if (checkedOutSha !== currentSha) {
  throw new Error('The checked-out commit does not match GITHUB_SHA')
}

let baseSha
let headSha
if (eventName === 'push') {
  baseSha = requiredSha('AUTHMODULES_PUSH_BASE_SHA')
  headSha = currentSha
} else if (eventName === 'workflow_dispatch') {
  if (required('GITHUB_REF') !== 'refs/heads/main') {
    throw new Error('Release repair must be dispatched from main')
  }
  baseSha = requiredSha('AUTHMODULES_REPAIR_BASE_SHA')
  headSha = requiredSha('AUTHMODULES_REPAIR_HEAD_SHA')
  await assertAncestor(headSha, currentSha, 'Release repair must target an ancestor of current main')

  const manifestPath = '.release-please-manifest.json'
  const releaseManifest = await git(['show', `${headSha}:${manifestPath}`])
  const currentManifest = await readFile(path.join(root, manifestPath), 'utf8')
  if (releaseManifest !== currentManifest) {
    throw new Error('Current main release manifest differs from the requested release commit')
  }
} else {
  throw new Error(`Unsupported release event: ${eventName}`)
}

const firstParentSha = (await git(['rev-parse', `${headSha}^1`])).trim()
if (firstParentSha !== baseSha) {
  throw new Error('Release base must be the first parent of the release commit')
}

await appendFile(outputPath, `base_sha=${baseSha}\n`)
await appendFile(outputPath, `head_sha=${headSha}\n`)
console.log(`Resolved ${eventName} release context ${baseSha}..${headSha}`)

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

async function assertAncestor(ancestor, descendant, message) {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant])
  } catch {
    throw new Error(message)
  }
}

async function git(args) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, ...args],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  return stdout
}
