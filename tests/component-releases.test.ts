import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { extractReleaseNotes } from '../scripts/release-notes.js'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const script = path.join(root, 'scripts', 'create-component-releases.js')
const releaseSha = (
  await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
).stdout.trim()
const otherSha = 'b'.repeat(40)

test('component Releases preflight, create, verify, and rerun idempotently', async () => {
  await withFixture({}, async (fixture) => {
    await fixture.run(matrix('contracts', 'core'))

    assert.deepEqual(fixture.tags(), ['contracts-v0.1.0', 'core-v0.1.0'])
    assert.equal(fixture.mutations().length, 2)
    for (const mutation of fixture.mutations()) {
      assert.equal(mutation.target_commitish, releaseSha)
      assert.equal(mutation.draft, false)
      assert.equal(mutation.prerelease, false)
      assert.equal(mutation.make_latest, 'false')
      assert.equal(typeof mutation.body, 'string')
      assert.notEqual(mutation.body.trim(), '')
    }

    await fixture.run(matrix('contracts', 'core'))
    assert.equal(fixture.mutations().length, 2)
  })
})

test('component Releases validate all changelogs before public mutations', async () => {
  await withFixture({}, async (fixture) => {
    const invalidMatrix = {
      include: [
        entry('contracts'),
        { ...entry('core'), version: '9.9.9' }
      ]
    }
    await assert.rejects(
      fixture.run(invalidMatrix),
      /packages\/core\/CHANGELOG\.md has no release notes for 9\.9\.9/
    )
    assert.deepEqual(fixture.mutations(), [])
  })
})

test('component Releases reject inconsistent remote state before mutations', async (context) => {
  await context.test('wrong tag target', async () => {
    await withFixture({
      tags: { 'contracts-v0.1.0': otherSha }
    }, async (fixture) => {
      await assert.rejects(
        fixture.run(matrix('contracts')),
        /points to .* instead of/
      )
      assert.deepEqual(fixture.mutations(), [])
    })
  })

  await context.test('wrong release metadata', async () => {
    await withFixture({
      releases: {
        'contracts-v0.1.0': { name: 'wrong title' }
      },
      tags: { 'contracts-v0.1.0': releaseSha }
    }, async (fixture) => {
      await assert.rejects(
        fixture.run(matrix('contracts')),
        /unexpected GitHub Release metadata/
      )
      assert.deepEqual(fixture.mutations(), [])
    })
  })

  await context.test('API failure', async () => {
    await withFixture({ failReads: true }, async (fixture) => {
      await assert.rejects(
        fixture.run(matrix('contracts')),
        /failed with 500/
      )
      assert.deepEqual(fixture.mutations(), [])
    })
  })
})

test('component Releases verify postconditions after successful API responses', async () => {
  await withFixture({ discardCreation: true }, async (fixture) => {
    await assert.rejects(
      fixture.run(matrix('contracts')),
      /is incomplete after release creation/
    )
    assert.equal(fixture.mutations().length, 1)
  })
})

test('component Releases recover when creation succeeds behind an API error', async () => {
  await withFixture({ createThenFail: true }, async (fixture) => {
    await fixture.run(matrix('contracts'))
    assert.equal(fixture.mutations().length, 1)
    assert.deepEqual(fixture.tags(), ['contracts-v0.1.0'])
  })
})

test('component Releases accept annotated tags that peel to the release commit', async () => {
  await withFixture({
    annotatedTags: { 'contracts-v0.1.0': 'c'.repeat(40) },
    releases: { 'contracts-v0.1.0': {} }
  }, async (fixture) => {
    await fixture.run(matrix('contracts'))
    assert.deepEqual(fixture.mutations(), [])
  })
})

async function withFixture(options, operation) {
  const tagTargets = new Map(Object.entries(options.tags ?? {}))
  const annotatedTags = new Map(Object.entries(options.annotatedTags ?? {}))
  const releases = new Map()
  const mutations = []

  for (const [tag, overrides] of Object.entries(options.releases ?? {})) {
    releases.set(tag, {
      ...await expectedRelease(tag),
      ...overrides
    })
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (options.failReads && request.method === 'GET') {
      return json(response, 500, { message: 'fixture failure' })
    }

    const refPrefix = '/repos/authmodules/authmodules/git/ref/tags/'
    if (request.method === 'GET' && url.pathname.startsWith(refPrefix)) {
      const tag = decodeURIComponent(url.pathname.slice(refPrefix.length))
      if (annotatedTags.has(tag)) {
        return json(response, 200, {
          object: { type: 'tag', sha: annotatedTags.get(tag) }
        })
      }
      if (!tagTargets.has(tag)) return json(response, 404, { message: 'Not Found' })
      return json(response, 200, {
        object: { type: 'commit', sha: tagTargets.get(tag) }
      })
    }

    const annotatedPrefix = '/repos/authmodules/authmodules/git/tags/'
    if (request.method === 'GET' && url.pathname.startsWith(annotatedPrefix)) {
      const annotatedSha = url.pathname.slice(annotatedPrefix.length)
      if (![...annotatedTags.values()].includes(annotatedSha)) {
        return json(response, 404, { message: 'Not Found' })
      }
      return json(response, 200, {
        object: { type: 'commit', sha: releaseSha }
      })
    }

    const releasePrefix = '/repos/authmodules/authmodules/releases/tags/'
    if (request.method === 'GET' && url.pathname.startsWith(releasePrefix)) {
      const tag = decodeURIComponent(url.pathname.slice(releasePrefix.length))
      if (!releases.has(tag)) return json(response, 404, { message: 'Not Found' })
      return json(response, 200, releases.get(tag))
    }

    if (
      request.method === 'POST'
      && url.pathname === '/repos/authmodules/authmodules/releases'
    ) {
      const body = JSON.parse(await readRequest(request))
      mutations.push(body)
      if (!options.discardCreation) {
        tagTargets.set(body.tag_name, body.target_commitish)
        releases.set(body.tag_name, body)
      }
      if (options.createThenFail) {
        return json(response, 500, { message: 'response lost after creation' })
      }
      return json(response, 201, body)
    }

    return json(response, 404, { message: 'Unhandled fixture endpoint' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  try {
    await operation({
      mutations: () => [...mutations],
      run: async (releaseMatrix) => {
        try {
          return await execFileAsync(process.execPath, [script], {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              AUTHMODULES_RELEASE_MATRIX: JSON.stringify(releaseMatrix),
              AUTHMODULES_RELEASE_SHA: releaseSha,
              GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
              GITHUB_REPOSITORY: 'authmodules/authmodules',
              GITHUB_TOKEN: 'test-token'
            },
            maxBuffer: 1024 * 1024
          })
        } catch (error) {
          throw new Error(error.stderr || error.message)
        }
      },
      tags: () => [...tagTargets.keys()].sort()
    })
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

async function expectedRelease(tag) {
  const separator = tag.lastIndexOf('-v')
  const name = tag.slice(0, separator)
  const version = tag.slice(separator + 2)
  const changelogPath = path.join(root, 'packages', name, 'CHANGELOG.md')
  const changelog = await readFile(changelogPath, 'utf8')
  return {
    body: extractReleaseNotes(changelog, version, changelogPath),
    draft: false,
    name: `${name}: v${version}`,
    prerelease: false,
    tag_name: tag,
    target_commitish: releaseSha
  }
}

function matrix(...names) {
  return { include: names.map(entry) }
}

function entry(name) {
  return {
    name,
    package: `@authmodules/${name}`,
    path: `packages/${name}`,
    version: '0.1.0'
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function readRequest(request) {
  let body = ''
  for await (const chunk of request) body += chunk
  return body
}
