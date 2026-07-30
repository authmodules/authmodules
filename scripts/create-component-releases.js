import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { extractReleaseNotes } from './release-notes.js'
import {
  isExactVersion,
  packageRepositories
} from './release-manifest.js'

const root = path.resolve(import.meta.dirname, '..')
const releaseSha = requiredSha('AUTHMODULES_RELEASE_SHA')
const repository = requiredRepository('GITHUB_REPOSITORY')
const token = required('GITHUB_TOKEN')
const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const entries = parseMatrix(required('AUTHMODULES_RELEASE_MATRIX'))
const expected = await Promise.all(entries.map(readExpectedRelease))

const states = await Promise.all(expected.map(inspectRelease))
for (const state of states) {
  if (!state.create) continue
  await createRelease(state)
}

const verified = await Promise.all(expected.map(inspectRelease))
for (const state of verified) {
  if (state.create) {
    throw new Error(`${state.tag} is incomplete after release creation`)
  }
}

console.log(`Verified ${verified.length} component GitHub Release(s)`)

async function readExpectedRelease(entry) {
  const changelogPath = path.join(root, entry.path, 'CHANGELOG.md')
  const changelog = await readFile(changelogPath, 'utf8')
  return {
    ...entry,
    notes: extractReleaseNotes(changelog, entry.version, `${entry.path}/CHANGELOG.md`),
    tag: `${entry.name}-v${entry.version}`,
    title: `${entry.name}: v${entry.version}`
  }
}

async function inspectRelease(expectedRelease) {
  const tagTarget = await resolveTagTarget(expectedRelease.tag)
  if (tagTarget !== undefined && tagTarget !== releaseSha) {
    throw new Error(
      `${expectedRelease.tag} points to ${tagTarget} instead of ${releaseSha}`
    )
  }

  const release = await requestJson(
    `repos/${repository}/releases/tags/${encodeURIComponent(expectedRelease.tag)}`,
    { allowNotFound: true }
  )
  if (release === undefined) {
    return { ...expectedRelease, create: true }
  }
  if (tagTarget === undefined) {
    throw new Error(`${expectedRelease.tag} has a GitHub Release without a tag`)
  }
  assertRelease(release, expectedRelease)
  return { ...expectedRelease, create: false }
}

async function resolveTagTarget(tag) {
  const reference = await requestJson(
    `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    { allowNotFound: true }
  )
  if (reference === undefined) return undefined

  let object = reference.object
  const visited = new Set()
  while (object?.type === 'tag') {
    if (!isSha(object.sha) || visited.has(object.sha) || visited.size >= 10) {
      throw new Error(`${tag} has an invalid annotated tag chain`)
    }
    visited.add(object.sha)
    const annotated = await requestJson(`repos/${repository}/git/tags/${object.sha}`)
    object = annotated.object
  }
  if (object?.type !== 'commit' || !isSha(object.sha)) {
    throw new Error(`${tag} must resolve to one commit`)
  }
  return object.sha
}

async function createRelease(state) {
  try {
    const release = await requestJson(`repos/${repository}/releases`, {
      body: {
        body: state.notes,
        draft: false,
        make_latest: 'false',
        name: state.title,
        prerelease: false,
        tag_name: state.tag,
        target_commitish: releaseSha
      },
      method: 'POST'
    })
    assertRelease(release, state)
    console.log(`Created ${state.tag}`)
  } catch (error) {
    try {
      const recovered = await inspectRelease(state)
      if (!recovered.create) {
        console.log(`${state.tag} already exists with the expected metadata`)
        return
      }
    } catch {
      // Preserve the original mutation failure when recovery cannot prove success.
    }
    throw error
  }
}

function assertRelease(release, expectedRelease) {
  if (
    release?.tag_name !== expectedRelease.tag
    || release.name !== expectedRelease.title
    || typeof release.body !== 'string'
    || release.body.trim() !== expectedRelease.notes
    || release.draft !== false
    || release.prerelease !== false
  ) {
    throw new Error(`${expectedRelease.tag} has unexpected GitHub Release metadata`)
  }
}

async function requestJson(relativeUrl, {
  allowNotFound = false,
  body,
  method = 'GET'
} = {}) {
  const response = await fetch(new URL(relativeUrl, `${apiUrl.replace(/\/$/, '')}/`), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-GitHub-Api-Version': '2022-11-28'
    },
    method
  })
  if (allowNotFound && response.status === 404) return undefined
  if (!response.ok) {
    const error = new Error(
      `GitHub API ${method} ${relativeUrl} failed with ${response.status}`
    )
    error.status = response.status
    throw error
  }
  return response.json()
}

function parseMatrix(source) {
  let matrix
  try {
    matrix = JSON.parse(source)
  } catch {
    throw new Error('AUTHMODULES_RELEASE_MATRIX must be valid JSON')
  }
  if (
    matrix === null
    || typeof matrix !== 'object'
    || Array.isArray(matrix)
    || !Array.isArray(matrix.include)
    || matrix.include.length === 0
    || matrix.include.length > packageRepositories.length
  ) {
    throw new Error('AUTHMODULES_RELEASE_MATRIX must contain changed packages')
  }

  const seen = new Set()
  return matrix.include.map((entry) => {
    const name = entry?.name
    if (
      typeof name !== 'string'
      || !packageRepositories.includes(name)
      || seen.has(name)
      || entry.package !== `@authmodules/${name}`
      || entry.path !== `packages/${name}`
      || !isExactVersion(entry.version)
    ) {
      throw new Error('AUTHMODULES_RELEASE_MATRIX contains an invalid package')
    }
    seen.add(name)
    return Object.freeze({
      name,
      package: entry.package,
      path: entry.path,
      version: entry.version
    })
  })
}

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredRepository(name) {
  const value = required(name)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${name} must use owner/repository format`)
  }
  return value
}

function requiredSha(name) {
  const value = required(name)
  if (!isSha(value)) throw new Error(`${name} must be a full lowercase commit SHA`)
  return value
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}
