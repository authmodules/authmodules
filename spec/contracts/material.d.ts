import type { PublicData } from './primitives.js'
import type { PrivateData } from './security.js'

/** Opaque method-owned credential material stored by core. `schemaVersion` is method-material schema, not store optimistic version. */
export type CredentialMaterial = {
  readonly schemaVersion: string
  readonly publicData?: PublicData
  readonly privateData?: PrivateData
}

/** Opaque method-owned challenge verifier/material stored by core. `schemaVersion` is method-material schema, not store optimistic version. */
export type ChallengeMaterial = {
  readonly schemaVersion: string
  readonly publicData?: PublicData
  readonly privateData?: PrivateData
}
