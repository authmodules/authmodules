import type { StoreFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import { serializeSecrets } from './secrets.ts'
import { isSafeStoredText } from '../shared/validation.ts'
import { storeErr } from '../shared/result.ts'

const secretDescriptorTypes = new Set<unknown>(['raw-secret', 'protected-value', 'sealed-secret'])

export function persistedJson(value: unknown): Result<string, StoreFailure> {
  try {
    return { ok: true, value: JSON.stringify(serializeSecrets(value)) }
  } catch {
    return storeErr('STORE_UNAVAILABLE')
  }
}

export function persistedPlainJson(value: unknown): Result<string | null, StoreFailure> {
  try {
    if (value === undefined) return { ok: true, value: null }
    return { ok: true, value: JSON.stringify(serializePlainJson(value)) }
  } catch {
    return storeErr('STORE_UNAVAILABLE')
  }
}

function serializePlainJson(value: unknown, depth = 0, state: TraversalState = {
  visiting: new Set<object>(),
  nodes: 0
}): unknown {
  state.nodes += 1
  if (state.nodes > 1000) throw new TypeError('JSON value is too large')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > 65536) throw new TypeError('JSON string is too large')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON number is invalid')
    return value
  }
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16 || state.visiting.has(value)) {
    throw new TypeError('JSON value is invalid')
  }
  if (isSecretDescriptor(value)) throw new TypeError('JSON value must not contain secret descriptors')
  if (hasFunction(value, 'reveal')
    || hasFunction(value, 'revealForPersistence')
    || hasFunction(value, 'revealCiphertextForPersistence')) {
    throw new TypeError('JSON value must not contain secrets')
  }
  state.visiting.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => serializePlainJson(item, depth + 1, state))
    }
    const entries = []
    for (const [key, item] of Object.entries(value)) {
      if (!isSafeStoredText(key, 512, true)) throw new TypeError('JSON object key is invalid')
      if (item === undefined) continue
      entries.push([key, serializePlainJson(item, depth + 1, state)])
    }
    return Object.fromEntries(entries)
  } finally {
    state.visiting.delete(value)
  }
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}

function isSecretDescriptor(value: object): boolean {
  return !Array.isArray(value) && 'type' in value && secretDescriptorTypes.has(value.type)
}

type TraversalState = {
  readonly visiting: Set<object>
  nodes: number
}
