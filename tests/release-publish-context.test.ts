import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const script = path.join(root, 'scripts', 'resolve-release-publish-context.js')

test('release publish context requires exact first-parent SHAs and main repair dispatches', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'authmodules-release-context-'))
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const currentSha = await git(['rev-parse', 'HEAD'])
  const parentSha = await git(['rev-parse', 'HEAD^1'])
  const distantAncestor = await git(['rev-parse', 'HEAD^1^1'])
  const outputPath = path.join(temporaryRoot, 'success-output')

  await runContext({
    AUTHMODULES_REPAIR_BASE_SHA: parentSha,
    AUTHMODULES_REPAIR_HEAD_SHA: currentSha,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_OUTPUT: outputPath,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: currentSha
  })
  assert.equal(
    await readFile(outputPath, 'utf8'),
    `base_sha=${parentSha}\nhead_sha=${currentSha}\n`
  )

  await assert.rejects(
    runContext({
      AUTHMODULES_REPAIR_BASE_SHA: distantAncestor,
      AUTHMODULES_REPAIR_HEAD_SHA: currentSha,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_OUTPUT: path.join(temporaryRoot, 'distant-output'),
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: currentSha
    }),
    /Release base must be the first parent/
  )

  await assert.rejects(
    runContext({
      AUTHMODULES_REPAIR_BASE_SHA: parentSha,
      AUTHMODULES_REPAIR_HEAD_SHA: currentSha,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_OUTPUT: path.join(temporaryRoot, 'branch-output'),
      GITHUB_REF: 'refs/heads/fix',
      GITHUB_SHA: currentSha
    }),
    /must be dispatched from main/
  )
})

async function runContext(environment) {
  try {
    await execFileAsync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...environment
      },
      maxBuffer: 1024 * 1024
    })
  } catch (error) {
    throw new Error(error.stderr || error.message)
  }
}

async function git(args) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, ...args],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  return stdout.trim()
}
