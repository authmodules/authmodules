import type { Actor, AuthContext, CreateSessionRequest, PublicData } from '@authmodules/contracts/primitives'
import { isStableMethodId } from './method.ts'

const authContextKeys = new Set([
  'actor',
  'ip',
  'locale',
  'metadata',
  'policyInput',
  'requestId',
  'tenantId',
  'userAgent'
])
const secretDescriptorTypes = new Set<unknown>(['raw-secret', 'protected-value', 'sealed-secret'])

export function isBaseOperationInput(input: unknown): input is {
  readonly context: AuthContext
  readonly methodId: string
  readonly input: unknown
  readonly account?: unknown
  readonly session?: CreateSessionRequest
} {
  return isRecord(input)
    && isAuthContext(input.context)
    && isStableMethodId(input.methodId)
    && 'input' in input
    && isCreateSessionRequest(input.session)
}

export function authContextFrom(input: unknown): AuthContext | undefined {
  return isRecord(input) && isAuthContext(input.context) ? input.context : undefined
}

export function isAuthContext(context: unknown): context is AuthContext {
  if (!isRecord(context)
    || !hasOnlyKeys(context, authContextKeys)
    || !isNonEmptyString(context.tenantId)) return false
  if (context.requestId !== undefined && !isNonEmptyString(context.requestId)) return false
  if (context.locale !== undefined
    && (!isBoundedString(context.locale, 128) || context.locale.length === 0)) return false
  if (context.ip !== undefined && !isBoundedString(context.ip, 512)) return false
  if (context.userAgent !== undefined && !isBoundedString(context.userAgent, 2048)) return false
  if (context.actor !== undefined && !isActor(context.actor)) return false
  return isPublicData(context.policyInput) && isPublicData(context.metadata)
}

function isActor(actor: unknown): actor is Actor {
  if (!isRecord(actor)) return false
  if (actor.type === 'anonymous') return hasOnlyKeys(actor, new Set(['type']))
  if (actor.type === 'account') {
    return hasOnlyKeys(actor, new Set(['accountId', 'type'])) && isNonEmptyString(actor.accountId)
  }
  if (actor.type === 'system') {
    return hasOnlyKeys(actor, new Set(['name', 'type'])) && isNonEmptyString(actor.name)
  }
  return false
}

export function isNonEmptyString(value: unknown): value is string {
  return isBoundedString(value, 512) && value.length > 0
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
}

export function isPublicData(value: unknown): value is PublicData | undefined {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  const state: JsonTraversalState = { visiting: new Set<object>(), nodes: 0, characters: 0 }
  return Object.entries(value).every(([key, item]) => consumeText(key, 512, state)
    && key.length > 0
    && isJsonValue(item, 0, state))
}

function isJsonValue(value: unknown, depth: number, state: JsonTraversalState): boolean {
  state.nodes += 1
  if (state.nodes > 1000) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return consumeText(value, 65536, state)
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || value instanceof Date) return false
  if (isSecretDescriptor(value)) return false
  if (hasFunction(value, 'reveal')
    || hasFunction(value, 'revealForPersistence')
    || hasFunction(value, 'revealCiphertextForPersistence')) return false
  if (depth >= 16 || state.visiting.has(value)) return false
  state.visiting.add(value)
  const valid = Array.isArray(value)
    ? isDenseJsonArray(value) && value.every((item) => isJsonValue(item, depth + 1, state))
    : isPlainObject(value) && Object.entries(value).every(([key, item]) => consumeText(key, 512, state)
      && key.length > 0
      && isJsonValue(item, depth + 1, state))
  state.visiting.delete(value)
  return valid
}

function consumeText(value: unknown, maxLength: number, state: JsonTraversalState): value is string {
  if (!isBoundedString(value, maxLength)) return false
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

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function isCreateSessionRequest(value: unknown): value is CreateSessionRequest | undefined {
  return value === undefined
    || (isRecord(value)
      && hasOnlyKeys(value, new Set(['ttlSeconds']))
      && (value.ttlSeconds === undefined
        || typeof value.ttlSeconds === 'number'))
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}

function isSecretDescriptor(value: object): boolean {
  return !Array.isArray(value) && 'type' in value && secretDescriptorTypes.has(value.type)
}

type JsonTraversalState = {
  readonly visiting: Set<object>
  nodes: number
  characters: number
}
