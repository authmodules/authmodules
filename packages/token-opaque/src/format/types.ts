import type { CryptoProvider } from '@authmodules/contracts/crypto'

export type OpaqueTokenFormatOptions = {
  readonly crypto: CryptoProvider
  readonly bytes?: number
  readonly scheme?: string
}
