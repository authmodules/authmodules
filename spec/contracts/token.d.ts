import type { Result } from './result.js'
import type { AccountId, SessionId, TenantId, PublicData } from './primitives.js'
import type { RawSecretValue, ProtectedValue } from './security.js'
import type { TokenFailure } from './errors.js'

export type TokenIssueInput = {
  readonly tenantId: TenantId
  readonly accountId: AccountId
  readonly sessionId: SessionId
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly claims?: PublicData
}

/** Internal token result used by core to persist tokenHash. Must not be returned directly by core public APIs. */
export type TokenIssueResult = {
  readonly raw: RawSecretValue<string>
  readonly tokenHash: ProtectedValue
}

/** Public token view returned by core/framework. Does not contain tokenHash; core supplies issuedAt/expiresAt from TokenIssueInput. */
export type IssuedTokenView = {
  readonly raw: RawSecretValue<string>
  readonly issuedAt: Date
  readonly expiresAt: Date
}

export type TokenIdentifyInput = {
  readonly raw: RawSecretValue<string>
  readonly expectedTenantId: TenantId
  readonly now: Date
}

export type TokenIdentity =
  | {
      readonly kind: 'by-token-hash'
      readonly tokenHash: ProtectedValue
      readonly claims?: PublicData
    }
  | {
      readonly kind: 'by-session'
      readonly tenantId: TenantId
      readonly sessionId: SessionId
      readonly tokenHash: ProtectedValue
      readonly claims?: PublicData
    }

export type TokenIdentifyResult = TokenIdentity | null

export interface TokenFormat {
  issue(input: TokenIssueInput): Promise<Result<TokenIssueResult, TokenFailure>>
  /**
   * Returns null for normal no-usable-token cases such as malformed, invalid, expired or tenant-mismatched token material.
   * Returns Result.ok=false only for infrastructure/crypto/internal token-format failures.
   */
  identify(input: TokenIdentifyInput): Promise<Result<TokenIdentifyResult, TokenFailure>>
}
