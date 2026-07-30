import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createPackageProvenance } from '../scripts/package-provenance.js'

const root = path.resolve(import.meta.dirname, '..')
const releaseSha = 'a'.repeat(40)
const workflowSha = 'b'.repeat(40)

test('package provenance distinguishes pinned release source from workflow definition', async () => {
  const provenance = createPackageProvenance(await contractsManifest(), trustedContext({
    eventName: 'workflow_dispatch',
    runAttempt: '2'
  }))

  assert.equal(
    provenance.buildDefinition.buildType,
    'https://actions.github.io/buildtypes/workflow/v1'
  )
  assert.deepEqual(
    provenance.buildDefinition.externalParameters,
    {
      workflow: {
        path: '.github/workflows/release-publish.yml',
        ref: 'refs/heads/main',
        repository: 'https://github.com/authmodules/authmodules'
      }
    }
  )
  assert.deepEqual(
    provenance.buildDefinition.internalParameters,
    {
      github: {
        event_name: 'workflow_dispatch',
        repository_id: '123456',
        repository_owner_id: '7890',
        runner_environment: 'github-hosted'
      }
    }
  )
  assert.deepEqual(provenance.buildDefinition.resolvedDependencies, [
    {
      uri: 'git+https://github.com/authmodules/authmodules@refs/heads/main',
      digest: { gitCommit: workflowSha }
    },
    {
      uri: `git+https://github.com/authmodules/authmodules@${releaseSha}`,
      digest: { gitCommit: releaseSha }
    }
  ])
  assert.equal(
    provenance.runDetails.builder.id,
    (
      'https://github.com/authmodules/authmodules/'
      + '.github/workflows/release-publish.yml@refs/heads/main'
    )
  )
  assert.equal(
    provenance.runDetails.metadata.invocationId,
    'https://github.com/authmodules/authmodules/actions/runs/12345/attempts/2'
  )
})

test('package provenance uses the standard external parameters for a push build', async () => {
  const provenance = createPackageProvenance(
    await contractsManifest(),
    trustedContext()
  )

  assert.deepEqual(
    provenance.buildDefinition.externalParameters,
    {
      workflow: {
        path: '.github/workflows/release-publish.yml',
        ref: 'refs/heads/main',
        repository: 'https://github.com/authmodules/authmodules'
      }
    }
  )
})

test('package provenance rejects an untrusted workflow path', async () => {
  const manifest = await contractsManifest()
  assert.throws(
    () => createPackageProvenance(manifest, trustedContext({
      eventName: 'workflow_dispatch',
      workflowRef: 'authmodules/authmodules/.github/workflows/other.yml@refs/heads/main'
    })),
    /publish workflow on main/
  )
})

test('package provenance rejects an untrusted workflow ref', async () => {
  const manifest = await contractsManifest()
  assert.throws(
    () => createPackageProvenance(manifest, trustedContext({
      eventName: 'workflow_dispatch',
      workflowRef: (
        'authmodules/authmodules/.github/workflows/release-publish.yml@refs/heads/fix'
      )
    })),
    /publish workflow on main/
  )
})

test('package provenance requires the standard GitHub builder identity fields', async () => {
  const manifest = await contractsManifest()
  const context = trustedContext()

  for (const [field, expected] of [
    ['repositoryId', /repository ID/],
    ['repositoryOwnerId', /repository owner ID/],
    ['runnerEnvironment', /runner environment/]
  ]) {
    assert.throws(
      () => createPackageProvenance(manifest, { ...context, [field]: '' }),
      expected
    )
  }
})

async function contractsManifest() {
  return JSON.parse(
    await readFile(path.join(root, 'packages', 'contracts', 'package.json'), 'utf8')
  )
}

function trustedContext(overrides = {}) {
  return {
    eventName: 'push',
    releaseSha,
    repository: 'authmodules/authmodules',
    repositoryId: '123456',
    repositoryOwnerId: '7890',
    runAttempt: '1',
    runId: '12345',
    runnerEnvironment: 'github-hosted',
    serverUrl: 'https://github.com',
    workflowRef: (
      'authmodules/authmodules/.github/workflows/release-publish.yml@refs/heads/main'
    ),
    workflowSha,
    ...overrides
  }
}
