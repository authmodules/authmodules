import { parseConventionalTitle } from './conventional-title.js'

export function assertConservativeApiRelease(baseVersion, currentVersion, pullRequestTitle) {
  const base = parseVersion(baseVersion)
  const current = parseVersion(currentVersion)

  if (hasConservativeVersionBump(base, current)) return

  const title = parseConventionalTitle(pullRequestTitle)
  const versionIsUnchanged = currentVersion === baseVersion
  const titleSchedulesRequiredRelease = base.major === 0
    ? title?.type === 'feat' || title?.breaking === true
    : title?.breaking === true

  if (versionIsUnchanged && titleSchedulesRequiredRelease) return

  const required = base.major === 0
    ? `at least 0.${base.minor + 1}.0`
    : `at least ${base.major + 1}.0.0`
  const requiredTitle = base.major === 0
    ? 'a feat or breaking Conventional Commit title'
    : 'a breaking Conventional Commit title'

  throw new Error(
    `Public API changed from ${baseVersion}; version ${currentVersion} is insufficient. `
    + `Use ${requiredTitle} so Release Please schedules ${required}, or include that version `
    + 'in a release pull request'
  )
}

function hasConservativeVersionBump(base, current) {
  return base.major === 0
    ? current.major > 0 || (current.major === 0 && current.minor > base.minor)
    : current.major > base.major
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (match === null) {
    throw new Error(`Expected an exact stable semantic version, received ${String(value)}`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}
