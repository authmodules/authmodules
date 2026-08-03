const conventionalTitle = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([a-z0-9][a-z0-9._/-]*\))?(!)?: .+$/

export function parseConventionalTitle(value) {
  if (typeof value !== 'string') return null
  const match = conventionalTitle.exec(value.trim())
  if (match === null) return null
  return {
    type: match[1],
    breaking: match[2] === '!'
  }
}

export function isConventionalTitle(value) {
  return parseConventionalTitle(value) !== null
}
