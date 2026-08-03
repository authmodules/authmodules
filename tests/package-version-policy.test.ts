import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isConventionalTitle,
  parseConventionalTitle
} from '../scripts/conventional-title.js'
import { assertConservativeApiRelease } from '../scripts/package-version-policy.js'

test('Conventional Commit titles are parsed once for checks and releases', () => {
  assert.deepEqual(parseConventionalTitle('feat(contracts)!: changed an API'), {
    type: 'feat',
    breaking: true
  })
  assert.equal(isConventionalTitle('chore(deps): updated tooling'), true)
  assert.equal(isConventionalTitle('Bump a dependency'), false)
})

test('pre-1.0 API changes require a minor release signal', () => {
  assert.doesNotThrow(() => {
    assertConservativeApiRelease('0.1.0', '0.1.0', 'feat: changed package compatibility')
  })
  assert.doesNotThrow(() => {
    assertConservativeApiRelease('0.1.0', '0.2.0', 'chore: release main')
  })
  assert.throws(
    () => assertConservativeApiRelease('0.1.0', '0.1.0', 'fix: changed package compatibility'),
    /feat or breaking Conventional Commit title/
  )
  assert.throws(
    () => assertConservativeApiRelease('0.1.0', '0.1.1', 'feat: changed package compatibility'),
    /version 0\.1\.1 is insufficient/
  )
})

test('stable API changes require a major release signal', () => {
  assert.doesNotThrow(() => {
    assertConservativeApiRelease('1.4.2', '1.4.2', 'feat(core)!: changed an API')
  })
  assert.doesNotThrow(() => {
    assertConservativeApiRelease('1.4.2', '2.0.0', 'chore: release main')
  })
  assert.throws(
    () => assertConservativeApiRelease('1.4.2', '1.4.2', 'feat: changed an API'),
    /breaking Conventional Commit title/
  )
})
