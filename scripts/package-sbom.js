import { createHash } from 'node:crypto'
import { isExactIntegrity } from './release-manifest.js'

const urlNamespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')

export function createPackageSbom(manifest, contractsManifest, tarballIntegrity) {
  if (!isExactIntegrity(tarballIntegrity)) {
    throw new Error('Package SBOM requires an exact SHA-512 tarball integrity')
  }
  const rootRef = packagePurl(manifest)
  const contractRange = manifest.peerDependencies?.['@authmodules/contracts']
  const includesContracts = contractRange !== undefined
  const contractsRef = packagePurl(contractsManifest)

  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuidV5([
      'https://github.com/authmodules/authmodules/sbom',
      rootRef,
      tarballIntegrity
    ].join('\n'))}`,
    version: 1,
    metadata: {
      component: createComponent(manifest, rootRef)
    },
    components: includesContracts
      ? [{
          ...createComponent(contractsManifest, contractsRef),
          scope: 'required',
          properties: [{
            name: 'authmodules:peerDependencyRange',
            value: contractRange
          }]
        }]
      : [],
    dependencies: [
      {
        ref: rootRef,
        dependsOn: includesContracts ? [contractsRef] : []
      },
      ...(includesContracts ? [{ ref: contractsRef, dependsOn: [] }] : [])
    ]
  }
}

function createComponent(manifest, bomRef) {
  return {
    type: 'library',
    'bom-ref': bomRef,
    group: 'authmodules',
    name: manifest.name.slice('@authmodules/'.length),
    version: manifest.version,
    description: manifest.description,
    licenses: [{
      license: {
        id: manifest.license
      }
    }],
    purl: bomRef
  }
}

function packagePurl(manifest) {
  return `pkg:npm/%40authmodules/${manifest.name.slice('@authmodules/'.length)}@${manifest.version}`
}

function uuidV5(name) {
  const bytes = Buffer.from(
    createHash('sha1').update(urlNamespace).update(name, 'utf8').digest().subarray(0, 16)
  )
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}
