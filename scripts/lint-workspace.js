import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootPath = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist'])

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue
    }

    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(absolutePath))
    } else {
      files.push(absolutePath)
    }
  }

  return files
}

const files = await walk(rootPath)

for (const file of files.filter((candidate) => candidate.endsWith('.md'))) {
  const content = await readFile(file, 'utf8')
  const relativePath = path.relative(rootPath, file)

  const rootRelativeLinks = [...content.matchAll(/\]\(\s*(\/[^)]*)\)/g)]
  for (const [, destination] of rootRelativeLinks) {
    const [target] = destination.trim().split(/\s+/, 1)
    fail(`${relativePath} contains a root-relative markdown link: ${target}`)
  }

  if (content.includes('file://')) {
    fail(`${relativePath} contains a file URL`)
  }
}

for (const file of files.filter((candidate) => candidate.endsWith('package.json'))) {
  const relativePath = path.relative(rootPath, file)
  try {
    JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`)
  }
}

if (!process.exitCode) {
  console.log('Workspace lint passed')
}
