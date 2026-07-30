import assert from 'node:assert/strict'
import test from 'node:test'
import { extractReleaseNotes } from '../scripts/release-notes.js'

test('release notes support initial and linked Release Please headings', () => {
  assert.equal(
    extractReleaseNotes(
      '# Changelog\n\n## 0.1.0 (2026-07-30)\n\n### Features\n\n* initial\n',
      '0.1.0'
    ),
    '### Features\n\n* initial'
  )
  assert.equal(
    extractReleaseNotes(
      [
        '# Changelog',
        '',
        '## [0.2.0](https://github.com/authmodules/authmodules/compare/contracts-v0.1.0...contracts-v0.2.0) (2026-08-01)',
        '',
        '### Features',
        '',
        '* next',
        '',
        '## 0.1.0 (2026-07-30)',
        '',
        '* initial'
      ].join('\n'),
      '0.2.0',
      'packages/contracts/CHANGELOG.md'
    ),
    '### Features\n\n* next'
  )
})

test('release notes reject missing or empty version sections', () => {
  assert.throws(
    () => extractReleaseNotes('# Changelog\n', '0.1.0'),
    /has no release notes/
  )
  assert.throws(
    () => extractReleaseNotes('# Changelog\n\n## 0.1.0\n', '0.1.0'),
    /has empty release notes/
  )
})
