import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const before = requiredSha('AUTHMODULES_BASE_SHA')
const head = requiredSha('AUTHMODULES_HEAD_SHA')
const root = path.resolve(import.meta.dirname, '..')

if (!token || !repository?.includes('/')) {
  throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required')
}

const pullRequests = await github(`/repos/${repository}/commits/${head}/pulls`)
const candidates = pullRequests.filter((pullRequest) => (
  pullRequest.merged_at
  && pullRequest.base.ref === 'main'
  && pullRequest.merge_commit_sha === head
  && pullRequest.head.repo?.full_name === repository
  && pullRequest.head.ref.startsWith('release-please--branches--main')
  && pullRequest.labels.some((label) => (
    label.name === 'autorelease: pending'
    || label.name === 'autorelease: tagged'
  ))
))

if (candidates.length !== 1) {
  throw new Error('Release commit must come from one merged Release Please pull request')
}

const { stdout } = await execFileAsync(
  'git',
  ['-C', root, 'diff', '--name-only', before, head],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
)
const changedFiles = stdout.trim().split('\n').filter(Boolean)
if (!changedFiles.includes('.release-please-manifest.json')) {
  throw new Error('Release commit must update .release-please-manifest.json')
}

const lifecycleLabels = candidates[0].labels.filter((label) => (
  label.name === 'autorelease: pending'
  || label.name === 'autorelease: tagged'
)).map((label) => label.name)
console.log(
  `Verified merged Release Please PR #${candidates[0].number}`
  + ` at ${head} (${lifecycleLabels.join(', ')})`
)

function requiredSha(name) {
  const value = process.env[name]
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    throw new Error(`${name} must be a full lowercase commit SHA`)
  }
  return value
}

async function github(endpoint) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub API GET ${endpoint} failed (${response.status})`)
  }
  return response.json()
}
