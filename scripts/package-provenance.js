import { isExactVersion } from './release-manifest.js'

const shaPattern = /^[0-9a-f]{40}$/
const workflowPath = '.github/workflows/release-publish.yml'

export function createPackageProvenance(manifest, context) {
  if (
    typeof manifest?.name !== 'string'
    || !/^@authmodules\/[a-z0-9-]+$/.test(manifest.name)
    || !isExactVersion(manifest.version)
  ) {
    throw new Error('Package provenance requires a package name and exact version')
  }
  if (!shaPattern.test(context?.releaseSha ?? '')) {
    throw new Error('Package provenance requires an exact release SHA')
  }
  if (!shaPattern.test(context?.workflowSha ?? '')) {
    throw new Error('Package provenance requires an exact workflow SHA')
  }
  if (context.repository !== 'authmodules/authmodules') {
    throw new Error('Package provenance requires the AuthModules repository')
  }
  if (!['push', 'workflow_dispatch'].includes(context.eventName)) {
    throw new Error('Package provenance requires a supported release event')
  }
  if (!/^[1-9][0-9]*$/.test(context.runId ?? '')) {
    throw new Error('Package provenance requires a GitHub Actions run ID')
  }
  if (!/^[1-9][0-9]*$/.test(context.runAttempt ?? '')) {
    throw new Error('Package provenance requires a GitHub Actions run attempt')
  }

  const workflow = parseWorkflowRef(context.workflowRef, context.repository)
  const repositoryUrl = `${requiredHttpsUrl(context.serverUrl)}/${context.repository}`
  const invocationId = `${repositoryUrl}/actions/runs/${context.runId}/attempts/${context.runAttempt}`
  const releaseSource = `git+${repositoryUrl}.git@${context.releaseSha}`
  const workflowSource = (
    `git+${repositoryUrl}.git@${workflow.ref}#${workflow.path}`
  )

  return {
    buildDefinition: {
      buildType: (
        `${repositoryUrl}/blob/${context.workflowSha}/`
        + 'docs/08-REPOSITORY-SETTINGS.md#package-release-provenance-v1'
      ),
      externalParameters: {
        package: {
          name: manifest.name,
          version: manifest.version
        },
        releaseSource: {
          repository: repositoryUrl,
          commit: context.releaseSha
        },
        workflow: {
          path: `/${workflow.path}`,
          ref: workflow.ref,
          repository: repositoryUrl
        }
      },
      internalParameters: {
        github: {
          eventName: context.eventName
        }
      },
      resolvedDependencies: [
        {
          name: 'release source',
          uri: releaseSource,
          digest: {
            gitCommit: context.releaseSha
          }
        },
        {
          name: 'release workflow',
          uri: workflowSource,
          digest: {
            gitCommit: context.workflowSha
          }
        }
      ]
    },
    runDetails: {
      builder: {
        id: 'https://github.com/actions/runner/github-hosted'
      },
      metadata: {
        invocationId
      }
    }
  }
}

function parseWorkflowRef(value, repository) {
  const prefix = `${repository}/`
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new Error('Package provenance requires a repository workflow ref')
  }
  const separator = value.lastIndexOf('@')
  const path = value.slice(prefix.length, separator)
  const ref = value.slice(separator + 1)
  if (separator < prefix.length || path !== workflowPath || ref.length === 0) {
    throw new Error('Package provenance requires the publish workflow ref')
  }
  return { path, ref }
}

function requiredHttpsUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Package provenance requires the GitHub server URL')
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Package provenance requires an HTTPS GitHub server origin')
  }
  return url.origin
}
