import type { StoreFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import type {
  ProtectedValue,
  SealedSecretValue,
  SecretFactory,
  StoredProtectedValue,
  StoredSealedSecretValue
} from '@authmodules/contracts/security'
import { date } from '../shared/date.ts'
import { isSafeStoredText, isStoredOptionalDate, isValidDate } from '../shared/validation.ts'
import { storeErr } from '../shared/result.ts'

type SecretReviver = Pick<SecretFactory, 'protectedValue' | 'sealedValue'>
type TraversalState = { readonly visiting: Set<object>; nodes: number; characters: number }

export function serializeSecrets(value: unknown, depth = 0, state: TraversalState = {
  visiting: new Set<object>(),
  nodes: 0,
  characters: 0
}): unknown {
  state.nodes += 1
  if (state.nodes > 1000) throw new TypeError('Persisted value is too large')
  if (value === undefined || value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (!consumeCharacters(state, value, 65536)) throw new TypeError('Persisted string is too large')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Persisted number is invalid')
    return value
  }
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16) {
    throw new TypeError('Persisted value is invalid')
  }
  if (hasFunction(value, 'revealForPersistence')) {
    if (!isProtectedValue(value)) {
      throw new TypeError('Protected value is invalid')
    }
    const verifier = value.revealForPersistence()
    if (!isSafeStoredText(value.scheme, 256, true)
      || !isSafeStoredText(verifier, 1_000_000, true)
      || (value.keyId !== undefined && !isSafeStoredText(value.keyId, 512, false))
      || (value.createdAt !== undefined && !isValidDate(value.createdAt))) {
      throw new TypeError('Protected value is invalid')
    }
    if (!consumeCharacters(state, value.scheme, 256)
      || !consumeCharacters(state, verifier, 1_000_000)
      || (value.keyId !== undefined && !consumeCharacters(state, value.keyId, 512))) {
      throw new TypeError('Persisted value is too large')
    }
    return {
      type: 'protected-value',
      scheme: value.scheme,
      value: verifier,
      keyId: value.keyId,
      createdAt: value.createdAt?.toISOString()
    }
  }
  if (hasFunction(value, 'revealCiphertextForPersistence')) {
    if (!isSealedSecretValue(value)) {
      throw new TypeError('Sealed value is invalid')
    }
    const ciphertext = value.revealCiphertextForPersistence()
    if (!isSafeStoredText(value.algorithm, 256, true)
      || !isSafeStoredText(value.keyId, 512, true)
      || !isSafeStoredText(ciphertext, 5_000_000, true)
      || (value.expiresAt !== undefined && !isValidDate(value.expiresAt))) {
      throw new TypeError('Sealed value is invalid')
    }
    if (!consumeCharacters(state, value.algorithm, 256)
      || !consumeCharacters(state, value.keyId, 512)
      || !consumeCharacters(state, ciphertext, 5_000_000)) {
      throw new TypeError('Persisted value is too large')
    }
    return {
      type: 'sealed-secret',
      algorithm: value.algorithm,
      keyId: value.keyId,
      ciphertext,
      expiresAt: value.expiresAt?.toISOString()
    }
  }
  if (hasFunction(value, 'reveal')) throw new Error('RawSecretValue cannot be persisted')
  if (state.visiting.has(value)) throw new TypeError('Persisted value must not contain cycles')
  state.visiting.add(value)
  try {
    if (Array.isArray(value)) {
      const serialized = value.map((item) => serializeSecrets(item, depth + 1, state))
      if (serialized.some((item) => item === undefined)) {
        throw new TypeError('Persisted arrays cannot contain undefined')
      }
      return serialized
    }
    const entries = []
    for (const [key, item] of Object.entries(value)) {
      if (!isSafeStoredText(key, 512, true)
        || !consumeCharacters(state, key, 512)) throw new TypeError('Persisted object key is invalid')
      const serialized = serializeSecrets(item, depth + 1, state)
      if (serialized !== undefined) entries.push([key, serialized])
    }
    return Object.fromEntries(entries)
  } finally {
    state.visiting.delete(value)
  }
}

export function reviveSecrets(
  value: unknown,
  secretFactory: SecretReviver = defaultSecretFactory,
  depth = 0,
  state: TraversalState = { visiting: new Set<object>(), nodes: 0, characters: 0 }
): unknown {
  state.nodes += 1
  if (state.nodes > 1000) throw new TypeError('Stored value is too large')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (!consumeCharacters(state, value, 65536)) throw new TypeError('Stored string is too large')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Stored number is invalid')
    return value
  }
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16 || state.visiting.has(value)) {
    throw new TypeError('Stored value is invalid')
  }
  if (isRecord(value) && value.type === 'protected-value') {
    if (!isSafeStoredText(value.scheme, 256, true)
      || !isSafeStoredText(value.value, 1_000_000, true)
      || (value.keyId !== undefined && !isSafeStoredText(value.keyId, 512, false))
      || !isStoredOptionalDate(value.createdAt)) {
      throw new TypeError('Stored protected value is invalid')
    }
    if (!consumeCharacters(state, value.scheme, 256)
      || !consumeCharacters(state, value.value, 1_000_000)
      || (value.keyId !== undefined && !consumeCharacters(state, value.keyId, 512))) {
      throw new TypeError('Stored value is too large')
    }
    return secretFactory.protectedValue({
      type: 'protected-value',
      scheme: value.scheme,
      value: value.value,
      keyId: value.keyId,
      createdAt: value.createdAt ? date(value.createdAt) : undefined
    })
  }
  if (isRecord(value) && value.type === 'sealed-secret') {
    if (!isSafeStoredText(value.algorithm, 256, true)
      || !isSafeStoredText(value.keyId, 512, true)
      || !isSafeStoredText(value.ciphertext, 5_000_000, true)
      || !isStoredOptionalDate(value.expiresAt)) {
      throw new TypeError('Stored sealed value is invalid')
    }
    if (!consumeCharacters(state, value.algorithm, 256)
      || !consumeCharacters(state, value.keyId, 512)
      || !consumeCharacters(state, value.ciphertext, 5_000_000)) {
      throw new TypeError('Stored value is too large')
    }
    return secretFactory.sealedValue({
      type: 'sealed-secret',
      ciphertext: value.ciphertext,
      algorithm: value.algorithm,
      keyId: value.keyId,
      expiresAt: value.expiresAt ? date(value.expiresAt) : undefined
    })
  }
  state.visiting.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => reviveSecrets(item, secretFactory, depth + 1, state))
    }
    const entries = []
    for (const [key, item] of Object.entries(value)) {
      if (!isSafeStoredText(key, 512, true)
        || !consumeCharacters(state, key, 512)) throw new TypeError('Stored object key is invalid')
      entries.push([key, reviveSecrets(item, secretFactory, depth + 1, state)])
    }
    return Object.fromEntries(entries)
  } finally {
    state.visiting.delete(value)
  }
}

function consumeCharacters(state: TraversalState, value: string, perValueLimit: number): boolean {
  if (value.length > perValueLimit) return false
  state.characters += value.length
  return state.characters <= 10_000_000
}

export function persistedTokenHash(value: unknown): Result<{
  readonly json: string
  readonly scheme: string
  readonly keyId: string
  readonly verifier: string
}, StoreFailure> {
  try {
    if (!isProtectedValue(value)) return storeErr('STORE_UNAVAILABLE')
    const scheme = value.scheme
    const keyId = value.keyId ?? ''
    const verifier = value.revealForPersistence()
    if (typeof scheme !== 'string' || scheme.length === 0
      || typeof keyId !== 'string'
      || typeof verifier !== 'string' || verifier.length === 0) {
      return storeErr('STORE_UNAVAILABLE')
    }
    return {
      ok: true,
      value: {
        json: JSON.stringify(serializeSecrets(value)),
        scheme,
        keyId,
        verifier
      }
    }
  } catch {
    return storeErr('STORE_UNAVAILABLE')
  }
}

export const defaultSecretFactory: SecretReviver = {
  protectedValue(input: StoredProtectedValue): ProtectedValue {
    return {
      type: 'protected-value',
      scheme: input.scheme,
      redacted: '[REDACTED]',
      keyId: input.keyId,
      createdAt: input.createdAt,
      revealForPersistence(): string {
        return input.value
      },
      toJSON(): string {
        return '[REDACTED]'
      }
    }
  },
  sealedValue(input: StoredSealedSecretValue): SealedSecretValue {
    return {
      type: 'sealed-secret',
      algorithm: input.algorithm,
      keyId: input.keyId,
      redacted: '[REDACTED]',
      expiresAt: input.expiresAt,
      revealCiphertextForPersistence(): string {
        return input.ciphertext
      },
      toJSON(): string {
        return '[REDACTED]'
      }
    }
  }
}

function isProtectedValue(value: unknown): value is ProtectedValue {
  return isRecord(value)
    && value.type === 'protected-value'
    && isSafeStoredText(value.scheme, 256, true)
    && typeof value.redacted === 'string'
    && typeof value.revealForPersistence === 'function'
    && typeof value.toJSON === 'function'
    && !hasFunction(value, 'reveal')
    && !hasFunction(value, 'revealCiphertextForPersistence')
}

function isSealedSecretValue(value: unknown): value is SealedSecretValue {
  return isRecord(value)
    && value.type === 'sealed-secret'
    && isSafeStoredText(value.algorithm, 256, true)
    && isSafeStoredText(value.keyId, 512, true)
    && typeof value.redacted === 'string'
    && typeof value.revealCiphertextForPersistence === 'function'
    && typeof value.toJSON === 'function'
    && !hasFunction(value, 'reveal')
    && !hasFunction(value, 'revealForPersistence')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}
