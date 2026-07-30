import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const script = path.join(root, 'scripts', 'resolve-github-release-state.js')
const releaseSha = (await execFileAsync(
  'git',
  ['-C', root, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' }
)).stdout.trim()
const otherSha = 'b'.repeat(40)
const annotatedTagSha = 'c'.repeat(40)

test('GitHub release state recovery handles absent, partial, and complete releases', async (context) => {
  await context.test('absent releases are created', async () => {
    await withGitHubFixture({ names: ['contracts'], present: [] }, async (fixture) => {
      assert.equal(await fixture.run('resolve'), 'create=true\nnormalize=false\n')
    })
  })

  await context.test('matching partial releases resume missing creation', async () => {
    await withGitHubFixture({
      names: ['contracts', 'core'],
      present: ['contracts']
    }, async (fixture) => {
      assert.equal(await fixture.run('resolve'), 'create=true\nnormalize=false\n')
    })
  })

  await context.test('complete pending releases normalize lifecycle and verify', async () => {
    await withGitHubFixture({
      labels: ['autorelease: pending'],
      names: ['contracts'],
      present: ['contracts']
    }, async (fixture) => {
      assert.equal(await fixture.run('resolve'), 'create=false\nnormalize=true\n')
      await fixture.run('normalize')
      assert.deepEqual(fixture.labels(), ['autorelease: tagged'])
      await fixture.run('verify')
    })
  })

  await context.test('complete tagged releases are an idempotent no-op', async () => {
    await withGitHubFixture({
      labels: ['autorelease: tagged'],
      names: ['contracts'],
      present: ['contracts']
    }, async (fixture) => {
      assert.equal(await fixture.run('resolve'), 'create=false\nnormalize=false\n')
      await fixture.run('verify')
    })
  })
})

test('GitHub release creation pins every mutation and recovers split state', async (context) => {
  await context.test('absent tags and releases are created at the release SHA', async () => {
    await withGitHubFixture({
      names: ['contracts', 'core'],
      present: []
    }, async (fixture) => {
      assert.equal(await fixture.run('resolve'), 'create=true\nnormalize=false\n')
      await fixture.run('create')
      assert.deepEqual(fixture.refs(), ['contracts', 'core'])
      assert.deepEqual(fixture.releases(), ['contracts', 'core'])
      assert.ok(fixture.mutations().every(({ sha }) => sha === releaseSha))
      assert.ok(fixture.releaseBodies().every((body) => body.includes('### Features')))
      await fixture.run('normalize')
      await fixture.run('verify')
    })
  })

  await context.test('a tag without a release resumes release creation', async () => {
    await withGitHubFixture({
      names: ['contracts'],
      refs: ['contracts'],
      releases: []
    }, async (fixture) => {
      assert.equal(await fixture.run('resolve'), 'create=true\nnormalize=false\n')
      await fixture.run('create')
      assert.deepEqual(fixture.refs(), ['contracts'])
      assert.deepEqual(fixture.releases(), ['contracts'])
    })
  })

  await context.test('a release without a tag recreates only the exact tag', async () => {
    await withGitHubFixture({
      names: ['contracts'],
      refs: [],
      releases: ['contracts']
    }, async (fixture) => {
      assert.equal(await fixture.run('resolve'), 'create=true\nnormalize=false\n')
      await fixture.run('create')
      assert.deepEqual(fixture.refs(), ['contracts'])
      assert.deepEqual(fixture.releases(), ['contracts'])
      assert.deepEqual(fixture.mutations(), [{
        kind: 'tag',
        name: 'contracts',
        sha: releaseSha
      }])
    })
  })
})

test('GitHub release state validates target commits and annotated tags', async (context) => {
  await context.test('a branch-valued release target is accepted when its tag is pinned', async () => {
    await withGitHubFixture({
      labels: ['autorelease: tagged'],
      names: ['contracts'],
      present: ['contracts'],
      releaseTarget: 'main'
    }, async (fixture) => {
      await fixture.run('verify')
      assert.deepEqual(fixture.mutations(), [])
    })
  })

  await context.test('annotated tags are peeled to the release commit', async () => {
    await withGitHubFixture({
      annotated: ['contracts'],
      labels: ['autorelease: tagged'],
      names: ['contracts'],
      present: ['contracts']
    }, async (fixture) => {
      assert.equal(await fixture.run('resolve'), 'create=false\nnormalize=false\n')
      await fixture.run('verify')
    })
  })

  await context.test('wrong tag targets are rejected before release mutations', async () => {
    await withGitHubFixture({
      labels: ['autorelease: pending'],
      names: ['contracts', 'core'],
      present: ['contracts'],
      refTarget: otherSha
    }, async (fixture) => {
      await assert.rejects(fixture.run('create'), /points to/)
      assert.deepEqual(fixture.mutations(), [])
    })
  })

  await context.test('lookalike Release Please branches are rejected', async () => {
    await withGitHubFixture({
      branch: 'release-please--branches--main--spoofed',
      labels: ['autorelease: pending'],
      names: ['contracts'],
      present: []
    }, async (fixture) => {
      await assert.rejects(fixture.run('resolve'), /must belong to one merged/)
      assert.deepEqual(fixture.mutations(), [])
    })
  })
})

async function withGitHubFixture(options, operation) {
  const names = options.names
  const refs = new Set(options.refs ?? options.present)
  const releases = new Set(options.releases ?? options.present)
  const annotated = new Set(options.annotated ?? [])
  const labels = new Set(options.labels ?? ['autorelease: pending'])
  const mutations = []
  const releaseBodies = []
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'authmodules-release-state-'))
  let runNumber = 0
  const pullRequest = () => ({
    number: 8,
    merged_at: '2026-07-30T00:00:00Z',
    merge_commit_sha: releaseSha,
    base: { ref: 'main' },
    head: {
      ref: options.branch ?? 'release-please--branches--main',
      repo: { full_name: 'authmodules/authmodules' }
    },
    labels: [...labels].map((name) => ({ name }))
  })

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const tag = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
    if (
      request.method === 'GET'
      && url.pathname === `/repos/authmodules/authmodules/commits/${releaseSha}/pulls`
    ) {
      return json(response, 200, [pullRequest()])
    }
    if (
      request.method === 'GET'
      && url.pathname === '/repos/authmodules/authmodules/pulls'
    ) {
      return json(response, 200, [pullRequest()])
    }
    if (
      request.method === 'GET'
      && url.pathname.startsWith('/repos/authmodules/authmodules/git/ref/tags/')
    ) {
      const name = tag.slice(0, -'-v0.1.0'.length)
      if (!refs.has(name)) return json(response, 404, { message: 'Not Found' })
      return json(response, 200, {
        object: annotated.has(name)
          ? { type: 'tag', sha: annotatedTagSha }
          : { type: 'commit', sha: options.refTarget ?? releaseSha }
      })
    }
    if (
      request.method === 'GET'
      && url.pathname.startsWith('/repos/authmodules/authmodules/releases/tags/')
    ) {
      const name = tag.slice(0, -'-v0.1.0'.length)
      if (!releases.has(name)) return json(response, 404, { message: 'Not Found' })
      return json(response, 200, {
        draft: false,
        name: `${name}: v0.1.0`,
        prerelease: false,
        tag_name: tag,
        target_commitish: options.releaseTarget ?? releaseSha
      })
    }
    if (
      request.method === 'GET'
      && url.pathname === `/repos/authmodules/authmodules/git/tags/${annotatedTagSha}`
    ) {
      return json(response, 200, {
        object: { type: 'commit', sha: options.refTarget ?? releaseSha }
      })
    }
    if (
      request.method === 'POST'
      && url.pathname === '/repos/authmodules/authmodules/git/refs'
    ) {
      const body = JSON.parse(await readRequest(request))
      const name = body.ref.slice('refs/tags/'.length, -'-v0.1.0'.length)
      if (refs.has(name)) return json(response, 422, { message: 'Reference exists' })
      refs.add(name)
      mutations.push({ kind: 'tag', name, sha: body.sha })
      return json(response, 201, {
        object: { type: 'commit', sha: body.sha },
        ref: body.ref
      })
    }
    if (
      request.method === 'POST'
      && url.pathname === '/repos/authmodules/authmodules/releases'
    ) {
      const body = JSON.parse(await readRequest(request))
      const name = body.tag_name.slice(0, -'-v0.1.0'.length)
      if (
        !refs.has(name)
        || releases.has(name)
        || body.target_commitish !== releaseSha
        || body.name !== `${name}: v0.1.0`
        || body.draft !== false
        || body.prerelease !== false
        || body.make_latest !== 'false'
      ) {
        return json(response, 422, { message: 'Invalid release state' })
      }
      releases.add(name)
      releaseBodies.push(body.body)
      mutations.push({ kind: 'release', name, sha: body.target_commitish })
      return json(response, 201, body)
    }
    if (
      request.method === 'POST'
      && url.pathname === '/repos/authmodules/authmodules/issues/8/labels'
    ) {
      const body = JSON.parse(await readRequest(request))
      for (const label of body.labels) labels.add(label)
      return json(response, 200, [...labels].map((name) => ({ name })))
    }
    if (
      request.method === 'DELETE'
      && url.pathname.endsWith(encodeURIComponent('autorelease: pending'))
    ) {
      labels.delete('autorelease: pending')
      response.writeHead(204).end()
      return
    }
    return json(response, 404, { message: 'Unhandled test endpoint' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const apiUrl = `http://127.0.0.1:${address.port}`

  try {
    await operation({
      labels: () => [...labels],
      mutations: () => [...mutations],
      refs: () => [...refs],
      releaseBodies: () => [...releaseBodies],
      releases: () => [...releases],
      run: async (mode) => {
        runNumber += 1
        const outputPath = path.join(temporaryRoot, `output-${runNumber}`)
        try {
          await execFileAsync(process.execPath, [script], {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              AUTHMODULES_RELEASE_MATRIX: JSON.stringify({
                include: names.map((name) => ({
                  name,
                  package: `@authmodules/${name}`,
                  path: `packages/${name}`,
                  version: '0.1.0'
                }))
              }),
              AUTHMODULES_RELEASE_SHA: releaseSha,
              AUTHMODULES_RELEASE_STATE_MODE: mode,
              GITHUB_API_URL: apiUrl,
              GITHUB_OUTPUT: outputPath,
              GITHUB_REPOSITORY: 'authmodules/authmodules',
              GITHUB_TOKEN: 'test-token'
            },
            maxBuffer: 1024 * 1024
          })
        } catch (error) {
          throw new Error(error.stderr || error.message)
        }
        if (mode !== 'resolve') return ''
        return readFile(outputPath, 'utf8')
      }
    })
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await rm(temporaryRoot, { recursive: true, force: true })
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
