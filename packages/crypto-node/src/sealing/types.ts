import type {
  RawSecretValue
} from '@authmodules/contracts/security'

export type NodeSecretSealerOptions = {
  readonly key: RawSecretValue<Uint8Array> | Uint8Array
  readonly keyId?: string
}
