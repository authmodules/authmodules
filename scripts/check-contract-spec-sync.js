import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const specDirectory = path.join(root, 'spec', 'contracts')
const packageDirectory = path.join(root, 'packages', 'contracts', 'src')

let failed = false

const specFiles = await listFiles(specDirectory)
const packageFiles = await listFiles(packageDirectory)
const specRelative = new Set(specFiles.map((file) => path.relative(specDirectory, file)))
const packageRelative = new Set(packageFiles.map((file) => path.relative(packageDirectory, file)))

for (const relativePath of specRelative) {
  if (!packageRelative.has(relativePath)) {
    fail(`contracts/src is missing ${relativePath}`)
    continue
  }

  const specContent = await readFile(path.join(specDirectory, relativePath), 'utf8')
  const packageContent = await readFile(path.join(packageDirectory, relativePath), 'utf8')
  if (specContent !== packageContent) {
    fail(`contracts/src/${relativePath} differs from spec/contracts/${relativePath}`)
  }
}

for (const relativePath of packageRelative) {
  if (!specRelative.has(relativePath)) {
    fail(`contracts/src has extra ${relativePath}`)
  }
}

if (!failed) {
  console.log('Contract spec sync passed')
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath))
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(absolutePath)
    }
  }

  return files.sort()
}

function fail(message) {
  console.error(message)
  failed = true
  process.exitCode = 1
}
