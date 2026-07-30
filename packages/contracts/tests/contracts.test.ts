import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
)

test('manifest exposes type-only contract entrypoints', () => {
  assert.equal(manifest.exports['.'].types, './src/index.d.ts')
  assert.equal(manifest.exports['.'].import, undefined)
  assert.equal(manifest.exports['./security'].types, './src/security.d.ts')
  assert.equal(manifest.exports['./extensions'].types, './src/extensions.d.ts')
})
