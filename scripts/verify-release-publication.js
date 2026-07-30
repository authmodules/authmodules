import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isExactIntegrity, isExactVersion, packageRepositories } from './release-manifest.js'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const evidenceRoot = path.resolve(required('AUTHMODULES_EVIDENCE_DIRECTORY'))
const baseSha = requiredSha('AUTHMODULES_BASE_SHA')
const token = required('GITHUB_TOKEN')
const repository = required('GITHUB_REPOSITORY')
const currentManifest = parseManifest(
  await readFile(path.join(root, '.release-please-manifest.json'), 'utf8')
)
const previousManifest = parseManifest(await gitShow(baseSha, '.release-please-manifest.json'))
const evidenceFiles = (await collectFiles(evidenceRoot))
  .filter((filePath) => filePath.endsWith('.evidence.json'))
const evidenceByPackage = new Map()

for (const filePath of evidenceFiles) {
  const evidence = JSON.parse(await readFile(filePath, 'utf8'))
  if (
    evidence.schemaVersion !== 1
    || !/^@authmodules\/[a-z0-9-]+$/.test(evidence.package ?? '')
    || !isExactVersion(evidence.version)
    || !isExactIntegrity(evidence.integrity)
  ) {
    throw new Error(`${path.relative(evidenceRoot, filePath)} is not valid release evidence`)
  }
  if (evidenceByPackage.has(evidence.package)) {
    throw new Error(`Duplicate release evidence for ${evidence.package}`)
  }
  evidenceByPackage.set(evidence.package, evidence)
}

const versions = {}
const integrities = {}
for (const name of packageRepositories) {
  const packagePath = `packages/${name}`
  const packageName = `@authmodules/${name}`
  const version = currentManifest[packagePath]
  if (!isExactVersion(version)) {
    throw new Error(`${packagePath} is missing from the committed release manifest`)
  }
  const evidence = evidenceByPackage.get(packageName)
  const changed = previousManifest[packagePath] !== version
  if (changed !== (evidence !== undefined)) {
    throw new Error(`${packageName} release evidence does not match the manifest diff`)
  }
  if (evidence && evidence.version !== version) {
    throw new Error(`${packageName} release evidence has the wrong version`)
  }

  const integrity = await retry(
    () => registryIntegrity(`${packageName}@${version}`),
    { attempts: 6, delayMilliseconds: 5_000 }
  )
  if (evidence && integrity !== evidence.integrity) {
    throw new Error(`${packageName}@${version} registry integrity differs from release evidence`)
  }
  await retry(
    () => verifyGitHubPackage(name),
    { attempts: 6, delayMilliseconds: 5_000 }
  )
  versions[name] = version
  integrities[name] = integrity
}

await runPackedConsumer(versions, integrities)
console.log('Published package set and clean consumer installation verified')

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredSha(name) {
  const value = required(name)
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} must be a full lowercase commit SHA`)
  }
  return value
}

function parseManifest(source) {
  const value = JSON.parse(source)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release manifest must be an object')
  }
  return value
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(absolutePath))
    else files.push(absolutePath)
  }
  return files
}

async function gitShow(ref, filePath) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, 'show', `${ref}:${filePath}`],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  return stdout
}

async function registryIntegrity(packageSpec) {
  try {
    const { stdout } = await execFileAsync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['view', packageSpec, 'dist.integrity', '--json', '--registry=https://npm.pkg.github.com'],
      {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 1024 * 1024
      }
    )
    const integrity = JSON.parse(stdout)
    if (!isExactIntegrity(integrity)) {
      throw new Error(`${packageSpec} registry metadata has no exact SHA-512 integrity`)
    }
    return integrity
  } catch {
    throw new Error(`Unable to verify ${packageSpec} in GitHub Packages`)
  }
}

async function verifyGitHubPackage(name) {
  const packageMetadata = await github(
    `/orgs/authmodules/packages/npm/${encodeURIComponent(name)}`
  )
  if (
    packageMetadata.visibility !== 'public'
    || packageMetadata.repository?.full_name !== repository
  ) {
    throw new Error(`@authmodules/${name} is not public and linked to ${repository}`)
  }
}

async function runPackedConsumer(expectedVersions, expectedIntegrities) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(root, 'scripts', 'check-packed-consumer.js')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTHMODULES_PUBLISHED_VERSIONS: JSON.stringify(expectedVersions),
        AUTHMODULES_PUBLISHED_INTEGRITIES: JSON.stringify(expectedIntegrities)
      },
      maxBuffer: 20 * 1024 * 1024
    }
  )
  process.stdout.write(stdout)
  process.stderr.write(stderr)
}

async function github(endpoint) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub API GET ${endpoint} failed (${response.status})`)
  }
  return response.json()
}

async function retry(operation, options) {
  let lastError
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < options.attempts) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMilliseconds))
      }
    }
  }
  throw lastError
}
