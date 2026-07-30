import type { TokenFormat, TokenIdentifyInput, TokenIssueInput } from '@authmodules/contracts/token'
import { type OpaqueTokenFormatOptions } from './types.ts'
import {
  snapshotRawToken,
  snapshotTokenHash,
  validIdentifyInput,
  validIssueInput
} from '../validation/token.ts'
import { tokenErr } from '../shared/result.ts'

export function createOpaqueTokenFormat(options: OpaqueTokenFormatOptions): TokenFormat

export function createOpaqueTokenFormat(options: OpaqueTokenFormatOptions): TokenFormat {
  if (!options || typeof options !== 'object') throw new TypeError('Opaque token options are required')
  const crypto = options.crypto
  const bytes = options.bytes ?? 32
  const scheme = options.scheme ?? 'opaque-token-sha256.v1'
  if (!crypto || typeof crypto.randomSecretString !== 'function' || typeof crypto.hash !== 'function') {
    throw new TypeError('Opaque token crypto provider is invalid')
  }
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new TypeError('Opaque token byte length must be an integer from 16 to 128')
  }
  if (typeof scheme !== 'string' || scheme.length > 256 || !/^[a-z0-9][a-z0-9.-]*\.v[1-9][0-9]*$/.test(scheme)) {
    throw new TypeError('Opaque token scheme must be a versioned stable identifier')
  }

  return {
    async issue(input?: TokenIssueInput) {
      if (!validIssueInput(input)) return tokenErr('TOKEN_INVALID')
      try {
        const raw = crypto.randomSecretString({ kind: 'base64url', bytes })
        const safeRaw = snapshotRawToken(raw, bytes)
        if (!safeRaw) {
          return tokenErr('TOKEN_INVALID')
        }
        const tokenHash = await crypto.hash({ value: safeRaw, scheme })
        if (!tokenHash.ok) {
          return tokenErr('CRYPTO_FAILED')
        }
        const safeTokenHash = snapshotTokenHash(tokenHash.value, scheme)
        if (!safeTokenHash) {
          return tokenErr('TOKEN_INVALID')
        }
        return {
          ok: true,
          value: {
            raw: safeRaw,
            tokenHash: safeTokenHash
          }
        }
      } catch {
        return tokenErr('CRYPTO_FAILED')
      }
    },
    async identify(input?: TokenIdentifyInput) {
      try {
        if (!validIdentifyInput(input, bytes)) return { ok: true, value: null }
      } catch {
        return { ok: true, value: null }
      }
      try {
        const safeRaw = snapshotRawToken(input.raw, bytes)
        if (!safeRaw) return { ok: true, value: null }
        const tokenHash = await crypto.hash({ value: safeRaw, scheme })
        if (!tokenHash.ok) {
          return tokenErr('CRYPTO_FAILED')
        }
        const safeTokenHash = snapshotTokenHash(tokenHash.value, scheme)
        if (!safeTokenHash) return tokenErr('TOKEN_INVALID')
        return {
          ok: true,
          value: {
            kind: 'by-token-hash',
            tokenHash: safeTokenHash
          }
        }
      } catch {
        return tokenErr('CRYPTO_FAILED')
      }
    }
  }
}
