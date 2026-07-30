import { appendFile } from 'node:fs/promises'

const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const outputPath = process.env.GITHUB_OUTPUT
const dispatch = process.env.AUTHMODULES_DISPATCH_CHECK === 'true'

if (!token || !repository?.includes('/')) {
  throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required')
}

const pullRequests = await github(
  `/repos/${repository}/pulls?state=open&base=main&per_page=100`
)
const candidates = pullRequests.filter((pullRequest) => (
  pullRequest.head.repo?.full_name === repository
  && pullRequest.head.ref === 'release-please--branches--main'
  && pullRequest.labels.some((label) => label.name === 'autorelease: pending')
))

if (candidates.length === 0) {
  console.log('Release Please did not create or update a release pull request')
  process.exit(0)
}
if (candidates.length !== 1) {
  throw new Error('Expected exactly one open Release Please pull request')
}

const [pullRequest] = candidates
if (outputPath) {
  await appendFile(outputPath, `base_sha=${pullRequest.base.sha}\n`)
  await appendFile(outputPath, `head_ref=${pullRequest.head.ref}\n`)
  await appendFile(outputPath, `head_sha=${pullRequest.head.sha}\n`)
  await appendFile(outputPath, `pr_number=${pullRequest.number}\n`)
  await appendFile(outputPath, `pr_title=${pullRequest.title}\n`)
}

if (!dispatch) {
  console.log(`Resolved release PR #${pullRequest.number} at ${pullRequest.head.sha}`)
  process.exit(0)
}

await github(`/repos/${repository}/actions/workflows/check.yml/dispatches`, {
  method: 'POST',
  body: JSON.stringify({
    ref: pullRequest.head.ref,
    inputs: {
      base_sha: pullRequest.base.sha,
      head_sha: pullRequest.head.sha,
      pr_title: pullRequest.title
    }
  })
})

console.log(
  `Dispatched check.yml for release PR #${pullRequest.number} at ${pullRequest.head.sha}`
)

async function github(endpoint, options = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? 'GET'} ${endpoint} failed (${response.status})`)
  }
  return response.status === 204 ? undefined : response.json()
}
