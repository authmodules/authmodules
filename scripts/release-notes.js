import { isExactVersion } from './release-manifest.js'

export function extractReleaseNotes(source, version, changelogPath = 'CHANGELOG.md') {
  if (typeof source !== 'string' || !isExactVersion(version)) {
    throw new Error('Release notes require changelog text and an exact version')
  }
  const lines = source.split(/\r?\n/)
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(
    `^## (?:${escapedVersion}|\\[${escapedVersion}\\]\\([^\\n]+\\))`
    + '(?: \\([^\\n]+\\))?$'
  )
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) {
    throw new Error(`${changelogPath} has no release notes for ${version}`)
  }
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const notes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim()
  if (notes.length === 0) {
    throw new Error(`${changelogPath} has empty release notes for ${version}`)
  }
  return notes
}
