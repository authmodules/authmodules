import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packageRepositories } from './release-manifest.js'

const thresholds = {
  lines: 90,
  branches: 75,
  functions: 90
}

const repositories = packageRepositories.filter((repository) => repository !== 'contracts')

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

if (!process.env.AUTHMODULES_POSTGRES_URL) {
  throw new Error('AUTHMODULES_POSTGRES_URL is required for the coverage gate')
}

for (const repository of repositories) {
  const repositoryRoot = path.join(workspaceRoot, repository)
  const tests = await packageTests(repositoryRoot)
  tests.push(...ecosystemTests(repository))
  const output = await runCoverage(repositoryRoot, tests)
  const summary = coverageSummary(output)
  console.log(`${repository}: ${summary.lines}% lines, ${summary.branches}% branches, ${summary.functions}% functions`)
}

console.log('Coverage gate passed')

async function packageTests(repositoryRoot) {
  const directory = path.join(repositoryRoot, 'tests')
  const entries = await readdir(directory)
  return entries
    .filter((entry) => entry.endsWith('.test.ts'))
    .map((entry) => path.join(directory, entry))
}

function ecosystemTests(repository) {
  const centralTests = path.join(projectRoot, 'tests')
  if (repository === 'core') {
    return [
      path.join(centralTests, 'auth-stack.test.ts'),
      path.join(centralTests, 'compliance-stack.test.ts')
    ]
  }
  if (repository === 'testkit') {
    return [
      path.join(centralTests, 'auth-stack.test.ts'),
      path.join(centralTests, 'compliance-stack.test.ts'),
      path.join(centralTests, 'outbox-stack.test.ts'),
      path.join(workspaceRoot, 'store-postgres', 'tests', 'store-postgres.test.ts')
    ]
  }
  return []
}

function runCoverage(repositoryRoot, tests) {
  const args = [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=src/**/*.ts',
    `--test-coverage-lines=${thresholds.lines}`,
    `--test-coverage-branches=${thresholds.branches}`,
    `--test-coverage-functions=${thresholds.functions}`,
    ...tests
  ]

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve(output)
      reject(new Error(`Coverage failed in ${path.basename(repositoryRoot)}\n${output.slice(-12000)}`))
    })
  })
}

function coverageSummary(output) {
  const plain = output.replace(/\u001B\[[0-9;]*m/g, '')
  const match = plain.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/)
  if (!match) throw new Error('Node coverage summary was not found')
  return { lines: match[1], branches: match[2], functions: match[3] }
}
