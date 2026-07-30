import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  isExactIntegrity,
  isExactVersion,
  packageRepositories,
  parseReleaseManifest
} from './release-manifest.js'

const execFileAsync = promisify(execFile)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const release = process.argv[2]

if (process.argv.length !== 3 || !isExactVersion(release)) {
  throw new Error('Usage: node scripts/preflight-release.js <exact-release-version>')
}

const manifestPath = path.resolve(`releases/${release}.json`)
const manifest = parseReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), release)
const planRef = `release-plan/v${release}`
const centralTag = `v${release}`
const planRevision = await resolveTagCommit('authmodules/authmodules', planRef)

if (planRevision !== undefined) {
  const planManifest = await resolveReleasePlanManifest(release, planRef)
  if (!jsonEqual(planManifest, manifest)) {
    throw new Error(`${manifestPath} does not match the manifest at ${planRef}`)
  }
}

const packageStatuses = await mapWithConcurrency(packageRepositories, 1, async (repository) => {
  const entry = manifest.packages[repository]
  const tagRevision = await resolveTagCommit(entry.repository, entry.tag)
  const githubRelease = await resolveGitHubRelease(entry.repository, entry.tag)
  const registryVersions = await resolvePackageVersions(repository)
  const registryVersion = registryVersions.includes(entry.version)
  const registryIntegrity = registryVersion
    ? await resolveRegistryIntegrity(repository, entry.version)
    : undefined

  if (tagRevision !== undefined && tagRevision !== entry.revision) {
    throw new Error(`${entry.repository} ${entry.tag} resolves to ${tagRevision}, expected ${entry.revision}`)
  }
  if (registryIntegrity !== undefined && registryIntegrity !== entry.integrity) {
    throw new Error(
      `${entry.repository} ${entry.version} registry integrity does not match the release manifest`
    )
  }
  if ((githubRelease || registryVersion) && tagRevision === undefined) {
    throw new Error(`${entry.repository} has released ${entry.version} without the manifest tag`)
  }

  return {
    package: repository,
    version: entry.version,
    tag: tagRevision === entry.revision ? 'matching' : 'missing',
    registry: registryVersion ? 'present' : 'missing',
    release: githubRelease ? 'present' : 'missing'
  }
})

const centralTagRevision = await resolveTagCommit('authmodules/authmodules', centralTag)
const centralRelease = await resolveGitHubRelease('authmodules/authmodules', centralTag)

if (
  planRevision !== undefined
  && centralTagRevision !== undefined
  && planRevision !== centralTagRevision
) {
  throw new Error(`${planRef} and ${centralTag} resolve to different central revisions`)
}
if (centralRelease && centralTagRevision === undefined) {
  throw new Error(`Central release ${centralTag} exists without its tag`)
}

console.table(packageStatuses)
console.log(JSON.stringify({
  release,
  planTag: planRevision === undefined ? 'missing' : planRevision,
  centralTag: centralTagRevision === undefined ? 'missing' : centralTagRevision,
  centralRelease: centralRelease ? 'present' : 'missing',
  incompletePackages: packageStatuses
    .filter((status) => status.tag !== 'matching' || status.registry !== 'present' || status.release !== 'present')
    .map((status) => status.package)
}, null, 2))

async function resolveTagCommit(repository, tag) {
  const encodedTag = tag.split('/').map(encodeURIComponent).join('/')
  const response = await ghJson(
    ['api', `repos/${repository}/git/ref/tags/${encodedTag}`],
    true
  )
  if (response === undefined) return undefined
  if (response.ref !== `refs/tags/${tag}`) {
    throw new Error(`${repository} ${tag} did not resolve to the exact requested tag`)
  }
  let object = response.object
  const visitedTags = new Set()

  for (let depth = 0; depth < 10; depth += 1) {
    if (
      object === null
      || typeof object !== 'object'
      || typeof object.sha !== 'string'
      || !/^[0-9a-f]{40}$/.test(object.sha)
      || (object.type !== 'commit' && object.type !== 'tag')
    ) {
      throw new Error(`${repository} ${tag} returned an invalid Git object`)
    }
    if (object.type === 'commit') return object.sha
    if (visitedTags.has(object.sha)) {
      throw new Error(`${repository} ${tag} contains a cyclic annotated tag chain`)
    }
    visitedTags.add(object.sha)
    const annotatedTag = await ghJson(
      ['api', `repos/${repository}/git/tags/${object.sha}`],
      false
    )
    object = annotatedTag?.object
  }

  throw new Error(`${repository} ${tag} exceeds the annotated tag depth limit`)
}

async function resolveGitHubRelease(repository, tag) {
  const response = await ghJson(
    ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`],
    true
  )
  if (response === undefined) return false
  if (response.tag_name !== tag || response.draft !== false || response.prerelease !== false) {
    throw new Error(`${repository} ${tag} must be a published stable GitHub Release`)
  }
  return true
}

async function resolveReleasePlanManifest(expectedRelease, ref) {
  const response = await ghJson([
    'api',
    '--method',
    'GET',
    `repos/authmodules/authmodules/contents/releases/${encodeURIComponent(expectedRelease)}.json`,
    '-f',
    `ref=${ref}`
  ], false)
  if (
    response?.type !== 'file'
    || response.encoding !== 'base64'
    || typeof response.content !== 'string'
    || !/^[A-Za-z0-9+/=\n]+$/.test(response.content)
  ) {
    throw new Error(`${ref} returned an invalid release manifest file`)
  }
  const decoded = Buffer.from(response.content.replaceAll('\n', ''), 'base64').toString('utf8')
  try {
    return parseReleaseManifest(JSON.parse(decoded), expectedRelease)
  } catch (error) {
    throw new Error(`${ref} release manifest is invalid: ${error.message}`)
  }
}

async function resolvePackageVersions(packageName) {
  const packageMetadata = await ghJson([
    'api',
    '--method',
    'GET',
    `orgs/authmodules/packages/npm/${encodeURIComponent(packageName)}`
  ], true)
  if (packageMetadata === undefined) return []
  if (
    packageMetadata.visibility !== 'public'
    || packageMetadata.repository?.full_name !== `authmodules/${packageName}`
    || packageMetadata.repository?.private !== false
  ) {
    throw new Error(`@authmodules/${packageName} must be public and linked to its public repository`)
  }

  const versions = await ghJson([
    'api',
    '--paginate',
    '--slurp',
    '--method',
    'GET',
    `orgs/authmodules/packages/npm/${encodeURIComponent(packageName)}/versions`,
    '-f',
    'per_page=100'
  ], true)
  if (versions === undefined) return []
  if (!Array.isArray(versions)) {
    throw new Error(`GitHub Packages returned an invalid version list for ${packageName}`)
  }
  const pages = versions.every(Array.isArray) ? versions : [versions]
  return pages
    .flat()
    .map((version) => version.name)
    .filter((name) => typeof name === 'string')
}

async function resolveRegistryIntegrity(packageName, version) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(
        npm,
        [
          'view',
          `@authmodules/${packageName}@${version}`,
          'dist.integrity',
          '--registry=https://npm.pkg.github.com',
          '--json'
        ],
        { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000 }
      )
      const integrity = JSON.parse(stdout)
      if (!isExactIntegrity(integrity)) {
        throw new Error('registry returned an invalid SHA-512 integrity')
      }
      return integrity
    } catch (error) {
      const diagnostic = processDiagnostic(error)
      if (isTransientProcessError(error, diagnostic) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
        continue
      }
      throw new Error(
        `GitHub Packages integrity lookup failed for @authmodules/${packageName}@${version}: `
        + diagnostic.trim()
      )
    }
  }
}

async function ghJson(args, allowMissing) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        args,
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 10_000 }
      )
      return JSON.parse(stdout)
    } catch (error) {
      const diagnostic = processDiagnostic(error)
      if (allowMissing && /(?:^|\s)HTTP 404(?:\s|$)|Not Found/.test(diagnostic)) {
        return undefined
      }
      if (isTransientProcessError(error, diagnostic) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
        continue
      }
      throw new Error(`GitHub release preflight failed: ${diagnostic.trim()}`)
    }
  }
}

function processDiagnostic(error) {
  return `${error?.message ?? ''}\n${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
}

function isTransientProcessError(error, diagnostic) {
  return error?.killed === true
    || error?.signal === 'SIGTERM'
    || error?.code === 'ETIMEDOUT'
    || /timed out|EOF|ETIMEDOUT|ECONNRESET|HTTP (?:502|503|504)/i.test(diagnostic)
}

async function mapWithConcurrency(values, limit, operation) {
  const results = new Array(values.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(limit, values.length) },
    () => worker()
  ))
  return results
}

function jsonEqual(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  )
}
