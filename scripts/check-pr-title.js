import { isConventionalTitle } from './conventional-title.js'

const title = process.env.AUTHMODULES_PR_TITLE?.trim()

if (!title) {
  console.log('Pull request title check skipped outside a pull request')
  process.exit(0)
}

if (!isConventionalTitle(title)) {
  throw new Error(
    'Pull request title must follow Conventional Commits because squash titles drive releases'
  )
}

console.log('Pull request title passed')
