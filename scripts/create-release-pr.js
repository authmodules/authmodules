import { GitHub } from 'release-please/build/src/github.js'
import { Manifest } from 'release-please/build/src/manifest.js'

const repository = required('GITHUB_REPOSITORY')
const token = required('GITHUB_TOKEN')
const [owner, repo, extra] = repository.split('/')

if (!owner || !repo || extra !== undefined) {
  throw new Error('GITHUB_REPOSITORY must use owner/repository format')
}

const github = await GitHub.create({ owner, repo, token })
const manifest = await Manifest.fromManifest(
  github,
  'main',
  'release-please-config.json',
  '.release-please-manifest.json',
  {
    labels: [],
    releaseLabels: [],
    skipLabeling: true
  }
)
const pullRequests = await manifest.createPullRequests()

console.log(
  pullRequests.length === 0
    ? 'No release pull request changes'
    : `Created or updated release pull request #${pullRequests.join(', #')}`
)

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
