import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

const rules = {
  contracts: {
    allowedRuntimePackages: [],
    allowedPackageDependencies: []
  },
  core: {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  testkit: {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'method-password': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'method-otp': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'store-postgres': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'crypto-node': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'token-opaque': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'carrier-cookie': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'delivery-email-smtp': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'effects-sync-delivery': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'framework-express': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'effects-outbox': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'outbox-worker': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  },
  'guard-memory': {
    allowedRuntimePackages: ['@authmodules/contracts'],
    allowedPackageDependencies: ['@authmodules/contracts']
  }
}

const importPattern = /(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)['"](@authmodules\/[^'"]+)/g
let failed = false

for (const [repository, rule] of Object.entries(rules)) {
  const repositoryPath = path.join(root, repository)
  const manifestPath = path.join(repositoryPath, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const dependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies']
  const declaredDependencies = new Set(
    dependencySections.flatMap((section) => Object.keys(manifest[section] ?? {}))
  )

  if (manifest.workspaces) {
    fail(`${repository}: package.json must not declare workspaces`)
  }

  for (const section of dependencySections) {
    for (const dependencyName of Object.keys(manifest[section] ?? {})) {
      if (!rule.allowedPackageDependencies.includes(dependencyName)) {
        fail(`${repository}: ${section} entry ${dependencyName} is not allowed by package boundary`)
      }
    }
  }

  const sourceFiles = await listSourceFiles(path.join(repositoryPath, 'src'))
  for (const sourceFile of sourceFiles) {
    const content = await readFile(sourceFile, 'utf8')
    const relativePath = path.relative(root, sourceFile)
    const imports = [...content.matchAll(importPattern)].map((match) => match[1])

    for (const imported of imports) {
      const packageName = packageNameOf(imported)
      if (!rule.allowedRuntimePackages.includes(packageName)) {
        fail(`${relativePath}: import ${imported} is not allowed by package boundary`)
      }
      if (packageName !== manifest.name && !declaredDependencies.has(packageName)) {
        fail(`${repository}: package.json must declare dependency or peer dependency ${packageName} used by ${relativePath}`)
      }
    }
  }
}

if (!failed) {
  console.log('Package boundaries passed')
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(absolutePath))
    } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
      files.push(absolutePath)
    }
  }

  return files
}

function packageNameOf(imported) {
  const [scope, name] = imported.split('/')
  return `${scope}/${name}`
}

function fail(message) {
  console.error(message)
  failed = true
  process.exitCode = 1
}
