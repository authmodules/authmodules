import type { JsonValue, PublicData } from '@authmodules/contracts/primitives'

type TraversalState = { visiting: Set<object>; nodes: number; characters: number }
const secretDescriptorTypes = new Set<unknown>(['raw-secret', 'protected-value', 'sealed-secret'])

export function isJsonObject(value: unknown): value is PublicData {
  if (!isPlainObject(value)) return false
  const state: TraversalState = { visiting: new Set<object>(), nodes: 0, characters: 0 }
  return Object.entries(value).every(([key, item]): boolean => (
    consumeText(key, 512, state) && key.length > 0 && isJsonValue(item, 0, state)
  ))
}

function isJsonValue(value: unknown, depth: number, state: TraversalState): value is JsonValue {
  state.nodes += 1
  if (state.nodes > 1000) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return consumeText(value, 65536, state)
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16 || state.visiting.has(value)) return false
  if (isSecretDescriptor(value)) return false
  if (hasFunction(value, 'reveal')
    || hasFunction(value, 'revealForPersistence')
    || hasFunction(value, 'revealCiphertextForPersistence')) return false
  state.visiting.add(value)
  const valid = Array.isArray(value)
    ? isDenseJsonArray(value) && value.every((item: unknown): boolean => isJsonValue(item, depth + 1, state))
    : isPlainObject(value) && Object.entries(value).every(([key, item]): boolean => (
      consumeText(key, 512, state) && key.length > 0 && isJsonValue(item, depth + 1, state)
    ))
  state.visiting.delete(value)
  return valid
}

function consumeText(value: unknown, maxLength: number, state: TraversalState): value is string {
  if (!isSafeText(value, maxLength)) return false
  state.characters += value.length
  return state.characters <= 1_000_000
}

function isDenseJsonArray(value: unknown[]): boolean {
  const keys = Object.keys(value)
  return keys.length === value.length && keys.every((key, index) => key === String(index))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function cloneJson(value: PublicData): PublicData
export function cloneJson(value: JsonValue): JsonValue
export function cloneJson(value: JsonValue | PublicData): JsonValue | PublicData {
  if (Array.isArray(value)) return value.map((item: JsonValue): JsonValue | PublicData => cloneJson(item)) as JsonValue
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]): [string, JsonValue | PublicData] => [key, cloneJson(item)]))
  }
  return value
}

export function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}

function isSecretDescriptor(value: object): boolean {
  return !Array.isArray(value) && 'type' in value && secretDescriptorTypes.has(value.type)
}
