import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createPackageSbom } from '../scripts/package-sbom.js'

const root = path.resolve(import.meta.dirname, '..')
const uuidV5Urn = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const integrity = `sha512-${'A'.repeat(86)}==`
const differentIntegrity = `sha512-${'B'.repeat(85)}A==`

test('package SBOMs are deterministic CycloneDX documents accepted by actions/attest', async () => {
  const contracts = await readManifest('contracts')
  const methodPassword = await readManifest('method-password')
  const sbom = createPackageSbom(methodPassword, contracts, integrity)

  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.equal(sbom.specVersion, '1.6')
  assert.match(sbom.serialNumber, uuidV5Urn)
  assert.deepEqual(sbom, createPackageSbom(methodPassword, contracts, integrity))
  assert.notEqual(
    sbom.serialNumber,
    createPackageSbom(contracts, contracts, integrity).serialNumber
  )
  assert.notEqual(
    sbom.serialNumber,
    createPackageSbom(methodPassword, contracts, differentIntegrity).serialNumber
  )
  assert.equal(sbom.metadata.component.name, 'method-password')
  assert.deepEqual(sbom.dependencies, [
    {
      ref: 'pkg:npm/%40authmodules/method-password@0.1.0',
      dependsOn: ['pkg:npm/%40authmodules/contracts@0.1.0']
    },
    {
      ref: 'pkg:npm/%40authmodules/contracts@0.1.0',
      dependsOn: []
    }
  ])
})

test('package SBOMs reject an inexact tarball integrity', async () => {
  const contracts = await readManifest('contracts')
  assert.throws(
    () => createPackageSbom(contracts, contracts, 'sha512-not-a-digest'),
    /exact SHA-512 tarball integrity/
  )
})

test('package SBOMs reject dependencies they cannot represent', async () => {
  const contracts = await readManifest('contracts')

  for (const [field, value] of [
    ['dependencies', { dependency: '1.0.0' }],
    ['optionalDependencies', { optional: '1.0.0' }],
    ['peerDependencies', { unsupported: '1.0.0' }]
  ]) {
    assert.throws(
      () => createPackageSbom({ ...contracts, [field]: value }, contracts, integrity),
      new RegExp(`${field} are not represented`)
    )
  }
})

async function readManifest(name) {
  return JSON.parse(
    await readFile(path.join(root, 'packages', name, 'package.json'), 'utf8')
  )
}
