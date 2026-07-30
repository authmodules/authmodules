import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  assertReleasePleaseManifest,
  isExactVersion,
  packageRepositories
} from './release-manifest.js'
import { extractReleaseNotes } from './release-notes.js'

const execFileAsync = promisify(execFile)
const mode = required('AUTHMODULES_RELEASE_STATE_MODE')
const releaseSha = requiredSha('AUTHMODULES_RELEASE_SHA')
const repository = required('GITHUB_REPOSITORY')
const token = required('GITHUB_TOKEN')
const outputPath = process.env.GITHUB_OUTPUT
const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com'
const matrix = parseMatrix(required('AUTHMODULES_RELEASE_MATRIX'))

if (repository !== 'authmodules/authmodules') {
  throw new Error('GITHUB_REPOSITORY must be authmodules/authmodules')
}
if (!['create', 'normalize', 'resolve', 'verify'].includes(mode)) {
  throw new Error('AUTHMODULES_RELEASE_STATE_MODE must be create, normalize, resolve, or verify')
}
if (mode === 'resolve' && !outputPath) {
  throw new Error('GITHUB_OUTPUT is required in resolve mode')
}

await assertReleaseMatrixSource()

const states = await Promise.all(matrix.map(async (entry) => {
  const tag = `${entry.name}-v${entry.version}`
  const [ref, release] = await Promise.all([
    github(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, {
      allowMissing: true
    }),
    github(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
      allowMissing: true
    })
  ])
  if (ref !== undefined) {
    await assertTagTarget(tag, ref)
  }
  if (release !== undefined) {
    assertReleaseMetadata(entry, tag, release)
  }
  return {
    entry,
    refPresent: ref !== undefined,
    releasePresent: release !== undefined,
    tag
  }
}))

const completeCount = states.filter((state) => (
  state.refPresent && state.releasePresent
)).length
const releasePullRequest = await getReleasePullRequest()
const lifecycle = releaseLifecycle(releasePullRequest)

if (mode === 'normalize') {
  if (completeCount !== states.length) {
    throw new Error('Only a complete release can be normalized')
  }
  if (!lifecycle.pending) {
    if (!lifecycle.tagged) {
      throw new Error('A complete release has no tagged lifecycle label')
    }
    console.log(`Release Please PR #${releasePullRequest.number} is already normalized`)
  } else {
    await github(
      `/repos/${repository}/issues/${releasePullRequest.number}/labels`,
      {
        body: { labels: ['autorelease: tagged'] },
        method: 'POST'
      }
    )
    await github(
      `/repos/${repository}/issues/${releasePullRequest.number}`
        + `/labels/${encodeURIComponent('autorelease: pending')}`,
      { allowMissing: true, method: 'DELETE' }
    )
    console.log(`Normalized Release Please PR #${releasePullRequest.number} to autorelease: tagged`)
  }
} else if (mode === 'verify') {
  if (
    completeCount !== states.length
    || lifecycle.pending
    || !lifecycle.tagged
  ) {
    throw new Error('Component releases and Release Please lifecycle are incomplete')
  }
  console.log(`${states.length} component releases match ${releaseSha}`)
} else if (mode === 'create') {
  if (completeCount !== states.length) {
    await assertOnlyPendingRelease(lifecycle)
    await createComponentReleases(states)
  } else {
    console.log(`${states.length} component releases already exist at ${releaseSha}`)
  }
} else if (completeCount === states.length) {
  await appendFile(outputPath, 'create=false\n')
  await appendFile(outputPath, `normalize=${lifecycle.pending}\n`)
  console.log(
    `${states.length} component releases already match ${releaseSha}`
    + `${lifecycle.pending ? ' and require label normalization' : ''}`
  )
} else {
  const pendingPullRequest = await assertOnlyPendingRelease(lifecycle)
  await appendFile(outputPath, 'create=true\n')
  await appendFile(outputPath, 'normalize=false\n')
  console.log(
    `Release Please PR #${pendingPullRequest.number}`
    + ` is the only pending release for ${releaseSha}`
  )
}

async function createComponentReleases(releaseStates) {
  const notes = new Map(await Promise.all(releaseStates.map(async ({ entry, tag }) => (
    [tag, await readReleaseNotes(entry)]
  ))))

  for (const state of releaseStates) {
    if (!state.refPresent) {
      await github(`/repos/${repository}/git/refs`, {
        allowConflict: true,
        body: {
          ref: `refs/tags/${state.tag}`,
          sha: releaseSha
        },
        method: 'POST'
      })
      const ref = await github(
        `/repos/${repository}/git/ref/tags/${encodeURIComponent(state.tag)}`
      )
      await assertTagTarget(state.tag, ref)
      state.refPresent = true
    }

    if (!state.releasePresent) {
      const currentRef = await github(
        `/repos/${repository}/git/ref/tags/${encodeURIComponent(state.tag)}`
      )
      await assertTagTarget(state.tag, currentRef)
      const release = await github(`/repos/${repository}/releases`, {
        allowConflict: true,
        body: {
          body: notes.get(state.tag),
          draft: false,
          make_latest: 'false',
          name: releaseName(state.entry),
          prerelease: false,
          tag_name: state.tag,
          target_commitish: releaseSha
        },
        method: 'POST'
      }) ?? await github(
        `/repos/${repository}/releases/tags/${encodeURIComponent(state.tag)}`
      )
      assertReleaseMetadata(state.entry, state.tag, release)
      state.releasePresent = true
    }
  }

  console.log(`${releaseStates.length} component releases reconciled at ${releaseSha}`)
}

async function assertOnlyPendingRelease(lifecycle) {
  if (!lifecycle.pending || lifecycle.tagged) {
    throw new Error('An incomplete component release must have only autorelease: pending')
  }
  const pendingPullRequests = await listPendingReleasePullRequests()
  if (
    pendingPullRequests.length !== 1
    || pendingPullRequests[0].merge_commit_sha !== releaseSha
  ) {
    throw new Error('Exactly one pending Release Please PR must match the release commit')
  }
  return pendingPullRequests[0]
}

async function getReleasePullRequest() {
  const pullRequests = await github(`/repos/${repository}/commits/${releaseSha}/pulls`)
  const candidates = pullRequests.filter((pullRequest) => (
    pullRequest.merged_at
    && pullRequest.base.ref === 'main'
    && pullRequest.merge_commit_sha === releaseSha
    && pullRequest.head.repo?.full_name === repository
    && pullRequest.head.ref === 'release-please--branches--main'
  ))
  if (candidates.length !== 1) {
    throw new Error('Release commit must belong to one merged Release Please PR')
  }
  return candidates[0]
}

function releaseLifecycle(pullRequest) {
  const labels = new Set(pullRequest.labels.map((label) => label.name))
  const lifecycle = {
    pending: labels.has('autorelease: pending'),
    tagged: labels.has('autorelease: tagged')
  }
  if (!lifecycle.pending && !lifecycle.tagged) {
    throw new Error('Release Please PR has no recognized lifecycle label')
  }
  return lifecycle
}

function parseMatrix(source) {
  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`AUTHMODULES_RELEASE_MATRIX is invalid JSON: ${error.message}`)
  }
  if (!Array.isArray(value?.include) || value.include.length === 0) {
    throw new Error('AUTHMODULES_RELEASE_MATRIX must contain release packages')
  }
  const names = new Set()
  const knownNames = new Set(packageRepositories)
  for (const entry of value.include) {
    if (
      entry === null
      || typeof entry !== 'object'
      || !/^[a-z0-9-]+$/.test(entry.name ?? '')
      || !knownNames.has(entry.name)
      || entry.package !== `@authmodules/${entry.name}`
      || entry.path !== `packages/${entry.name}`
      || !isExactVersion(entry.version)
      || names.has(entry.name)
    ) {
      throw new Error('AUTHMODULES_RELEASE_MATRIX contains an invalid package')
    }
    names.add(entry.name)
  }
  return value.include
}

async function assertReleaseMatrixSource() {
  let manifest
  try {
    manifest = JSON.parse(
      await gitShow(releaseSha, '.release-please-manifest.json')
    )
  } catch (error) {
    throw new Error(`Unable to validate the release manifest at ${releaseSha}: ${error.message}`)
  }
  assertReleasePleaseManifest(manifest, { label: 'Release source manifest' })

  await Promise.all(matrix.map(async (entry) => {
    let packageManifest
    try {
      packageManifest = JSON.parse(
        await gitShow(releaseSha, `${entry.path}/package.json`)
      )
    } catch (error) {
      throw new Error(`Unable to validate ${entry.path} at ${releaseSha}: ${error.message}`)
    }
    if (
      manifest[entry.path] !== entry.version
      || packageManifest.name !== entry.package
      || packageManifest.version !== entry.version
    ) {
      throw new Error(`${entry.path} release matrix does not match the pinned source`)
    }
  }))
}

async function listPendingReleasePullRequests() {
  const pending = []
  for (let page = 1; page <= 20; page += 1) {
    const pullRequests = await github(
      `/repos/${repository}/pulls?state=closed&base=main&per_page=100&page=${page}`
    )
    for (const pullRequest of pullRequests) {
      if (
        pullRequest.merged_at
        && pullRequest.head.repo?.full_name === repository
        && pullRequest.head.ref === 'release-please--branches--main'
        && pullRequest.labels.some((label) => label.name === 'autorelease: pending')
      ) {
        pending.push(pullRequest)
      }
    }
    if (pullRequests.length < 100) return pending
  }
  throw new Error('Release Please pull request pagination exceeded the safety bound')
}

async function peelTag(object) {
  let current = object
  for (let depth = 0; depth < 5; depth += 1) {
    if (current?.type === 'commit' && /^[0-9a-f]{40}$/.test(current.sha ?? '')) {
      return current.sha
    }
    if (current?.type !== 'tag' || !/^[0-9a-f]{40}$/.test(current.sha ?? '')) {
      throw new Error('Component tag does not resolve to a commit')
    }
    const tag = await github(`/repos/${repository}/git/tags/${current.sha}`)
    current = tag.object
  }
  throw new Error('Component tag nesting exceeded the safety bound')
}

async function assertTagTarget(tag, ref) {
  const targetSha = await peelTag(ref.object)
  if (targetSha !== releaseSha) {
    throw new Error(`${tag} points to ${targetSha} instead of ${releaseSha}`)
  }
}

function assertReleaseMetadata(entry, tag, release) {
  if (
    release.tag_name !== tag
    || release.name !== releaseName(entry)
    || release.draft
    || release.prerelease
    || release.target_commitish !== releaseSha
  ) {
    throw new Error(`${tag} GitHub Release metadata does not match the release commit`)
  }
}

function releaseName(entry) {
  return `${entry.name}: v${entry.version}`
}

async function readReleaseNotes(entry) {
  const changelogPath = `${entry.path}/CHANGELOG.md`
  const source = await gitShow(releaseSha, changelogPath)
  return extractReleaseNotes(source, entry.version, changelogPath)
}

async function gitShow(ref, filePath) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${ref}:${filePath}`],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    )
    return stdout
  } catch {
    throw new Error(`Unable to read ${filePath} at ${ref}`)
  }
}

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

async function github(
  endpoint,
  { allowConflict = false, allowMissing = false, body, method = 'GET' } = {}
) {
  const response = await fetch(`${apiUrl}${endpoint}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-GitHub-Api-Version': '2022-11-28'
    },
    method
  })
  if (allowMissing && response.status === 404) return undefined
  if (allowConflict && (response.status === 409 || response.status === 422)) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${endpoint} failed (${response.status})`)
  }
  if (response.status === 204) return undefined
  return response.json()
}
