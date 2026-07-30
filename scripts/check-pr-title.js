const title = process.env.AUTHMODULES_PR_TITLE?.trim()

if (!title) {
  console.log('Pull request title check skipped outside a pull request')
  process.exit(0)
}

const conventionalTitle = /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([a-z0-9][a-z0-9._/-]*\))?!?: .+/

if (!conventionalTitle.test(title)) {
  throw new Error(
    'Pull request title must follow Conventional Commits because squash titles drive releases'
  )
}

console.log('Pull request title passed')
