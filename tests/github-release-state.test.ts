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
const releaseSha = 'a'.repeat(40)
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

test('GitHub release state validates target commits and annotated tags', async (context) => {
  await context.test('wrong release target is rejected', async () => {
    await withGitHubFixture({
      labels: ['autorelease: tagged'],
      names: ['contracts'],
      present: ['contracts'],
      releaseTarget: otherSha
    }, async (fixture) => {
      await assert.rejects(fixture.run('resolve'), /metadata does not match/)
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
})

async function withGitHubFixture(options, operation) {
  const names = options.names
  const present = new Set(options.present)
  const annotated = new Set(options.annotated ?? [])
  const labels = new Set(options.labels ?? ['autorelease: pending'])
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'authmodules-release-state-'))
  let runNumber = 0
  const pullRequest = () => ({
    number: 8,
    merged_at: '2026-07-30T00:00:00Z',
    merge_commit_sha: releaseSha,
    base: { ref: 'main' },
    head: {
      ref: 'release-please--branches--main--components',
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
      if (!present.has(name)) return json(response, 404, { message: 'Not Found' })
      return json(response, 200, {
        object: annotated.has(name)
          ? { type: 'tag', sha: annotatedTagSha }
          : { type: 'commit', sha: releaseSha }
      })
    }
    if (
      request.method === 'GET'
      && url.pathname.startsWith('/repos/authmodules/authmodules/releases/tags/')
    ) {
      const name = tag.slice(0, -'-v0.1.0'.length)
      if (!present.has(name)) return json(response, 404, { message: 'Not Found' })
      return json(response, 200, {
        draft: false,
        tag_name: tag,
        target_commitish: options.releaseTarget ?? releaseSha
      })
    }
    if (
      request.method === 'GET'
      && url.pathname === `/repos/authmodules/authmodules/git/tags/${annotatedTagSha}`
    ) {
      return json(response, 200, {
        object: { type: 'commit', sha: releaseSha }
      })
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
