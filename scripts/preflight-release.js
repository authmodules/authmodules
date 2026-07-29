import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isExactVersion, packageRepositories, parseReleaseManifest } from './release-manifest.js'

const execFileAsync = promisify(execFile)
const release = process.argv[2]

if (process.argv.length !== 3 || !isExactVersion(release)) {
  throw new Error('Usage: node scripts/preflight-release.js <exact-release-version>')
}

const manifestPath = path.resolve(`releases/${release}.json`)
const manifest = parseReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), release)
const packageStatuses = await mapWithConcurrency(packageRepositories, 1, async (repository) => {
  const entry = manifest.packages[repository]
  const tagRevision = await resolveCommit(entry.repository, entry.tag)
  const githubRelease = await resolveGitHubRelease(entry.repository, entry.tag)
  const registryVersions = await resolvePackageVersions(repository)
  const registryVersion = registryVersions.includes(entry.version)

  if (tagRevision !== undefined && tagRevision !== entry.revision) {
    throw new Error(`${entry.repository} ${entry.tag} resolves to ${tagRevision}, expected ${entry.revision}`)
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

const planRef = `release-plan/v${release}`
const centralTag = `v${release}`
const planRevision = await resolveCommit('authmodules/authmodules', planRef)
const centralTagRevision = await resolveCommit('authmodules/authmodules', centralTag)
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

async function resolveCommit(repository, ref) {
  const response = await ghJson(['api', `repos/${repository}/commits/${encodeURIComponent(ref)}`], true)
  if (response === undefined) return undefined
  if (typeof response.sha !== 'string' || !/^[0-9a-f]{40}$/.test(response.sha)) {
    throw new Error(`${repository} ${ref} did not resolve to one commit`)
  }
  return response.sha
}

async function resolveGitHubRelease(repository, tag) {
  return (await ghJson(
    ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`],
    true
  )) !== undefined
}

async function resolvePackageVersions(packageName) {
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
      const diagnostic = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
      if (allowMissing && /(?:^|\s)HTTP 404(?:\s|$)|Not Found/.test(diagnostic)) {
        return undefined
      }
      const transient = /EOF|ETIMEDOUT|ECONNRESET|HTTP (?:502|503|504)/.test(diagnostic)
      if (transient && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
        continue
      }
      throw new Error(`GitHub release preflight failed: ${diagnostic.trim()}`)
    }
  }
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
