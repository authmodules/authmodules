import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createPackageProvenance } from '../scripts/package-provenance.js'

const root = path.resolve(import.meta.dirname, '..')
const releaseSha = 'a'.repeat(40)
const workflowSha = 'b'.repeat(40)

test('package provenance distinguishes pinned release source from workflow definition', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'packages', 'contracts', 'package.json'), 'utf8')
  )
  const provenance = createPackageProvenance(manifest, {
    eventName: 'workflow_dispatch',
    releaseSha,
    repository: 'authmodules/authmodules',
    runAttempt: '2',
    runId: '12345',
    serverUrl: 'https://github.com',
    workflowRef: (
      'authmodules/authmodules/.github/workflows/release-publish.yml@refs/heads/main'
    ),
    workflowSha
  })

  assert.equal(
    provenance.buildDefinition.buildType,
    (
      `https://github.com/authmodules/authmodules/blob/${workflowSha}/`
      + 'docs/08-REPOSITORY-SETTINGS.md#package-release-provenance-v1'
    )
  )
  assert.deepEqual(provenance.buildDefinition.resolvedDependencies, [
    {
      name: 'release source',
      uri: `git+https://github.com/authmodules/authmodules.git@${releaseSha}`,
      digest: { gitCommit: releaseSha }
    },
    {
      name: 'release workflow',
      uri: (
        'git+https://github.com/authmodules/authmodules.git@refs/heads/main'
        + '#.github/workflows/release-publish.yml'
      ),
      digest: { gitCommit: workflowSha }
    }
  ])
  assert.equal(
    provenance.buildDefinition.externalParameters.releaseSource.commit,
    releaseSha
  )
  assert.equal(
    provenance.runDetails.metadata.invocationId,
    'https://github.com/authmodules/authmodules/actions/runs/12345/attempts/2'
  )
})

test('package provenance rejects an untrusted workflow path', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'packages', 'contracts', 'package.json'), 'utf8')
  )
  assert.throws(
    () => createPackageProvenance(manifest, {
      eventName: 'workflow_dispatch',
      releaseSha,
      repository: 'authmodules/authmodules',
      runAttempt: '1',
      runId: '12345',
      serverUrl: 'https://github.com',
      workflowRef: 'authmodules/authmodules/.github/workflows/other.yml@refs/heads/main',
      workflowSha
    }),
    /publish workflow ref/
  )
})
