import { isExactVersion } from './release-manifest.js'

const shaPattern = /^[0-9a-f]{40}$/
const numericIdPattern = /^[1-9][0-9]*$/
const workflowPath = '.github/workflows/release-publish.yml'
const workflowRef = 'refs/heads/main'
const githubActionsBuildType = 'https://actions.github.io/buildtypes/workflow/v1'

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
  if (!numericIdPattern.test(context.repositoryId ?? '')) {
    throw new Error('Package provenance requires a GitHub repository ID')
  }
  if (!numericIdPattern.test(context.repositoryOwnerId ?? '')) {
    throw new Error('Package provenance requires a GitHub repository owner ID')
  }
  if (!['github-hosted', 'self-hosted'].includes(context.runnerEnvironment)) {
    throw new Error('Package provenance requires a GitHub runner environment')
  }

  const workflow = parseWorkflowRef(context.workflowRef, context.repository)
  const repositoryUrl = `${requiredHttpsUrl(context.serverUrl)}/${context.repository}`
  const invocationId = `${repositoryUrl}/actions/runs/${context.runId}/attempts/${context.runAttempt}`
  const releaseSource = `git+${repositoryUrl}@${context.releaseSha}`
  const workflowSource = `git+${repositoryUrl}@${workflow.ref}`

  return {
    buildDefinition: {
      buildType: githubActionsBuildType,
      externalParameters: {
        workflow: {
          ref: workflow.ref,
          repository: repositoryUrl,
          path: workflow.path
        }
      },
      internalParameters: {
        github: {
          event_name: context.eventName,
          repository_id: context.repositoryId,
          repository_owner_id: context.repositoryOwnerId,
          runner_environment: context.runnerEnvironment
        }
      },
      resolvedDependencies: [
        {
          uri: workflowSource,
          digest: {
            gitCommit: context.workflowSha
          }
        },
        {
          uri: releaseSource,
          digest: {
            gitCommit: context.releaseSha
          }
        }
      ]
    },
    runDetails: {
      builder: {
        id: `${repositoryUrl}/${workflow.path}@${workflow.ref}`
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
  if (separator < prefix.length || path !== workflowPath || ref !== workflowRef) {
    throw new Error('Package provenance requires the publish workflow on main')
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
