import type {
  HttpRequestView
} from '@authmodules/contracts/carrier'
import type { Actor, AuthContext, PublicData, TenantId } from '@authmodules/contracts/primitives'
import { type ExpressLikeRequest } from '../adapter/types.ts'
import { isSafeHeaderValue } from './headers.ts'
import { isSafeContextText } from '../shared/context-text.ts'

const actorAccountKeys = new Set(['accountId', 'type'])
const actorAnonymousKeys = new Set(['type'])
const actorSystemKeys = new Set(['name', 'type'])
const secretDescriptorTypes = new Set<unknown>(['protected-value', 'raw-secret', 'sealed-secret'])

export function toHttpRequestView(req: ExpressLikeRequest): HttpRequestView {
  if (!req || typeof req !== 'object') throw new TypeError('Request is required')
  const headersSource = req.headers
  const cookiesSource = req.cookies
  if (headersSource !== undefined
    && (!headersSource || typeof headersSource !== 'object' || Array.isArray(headersSource))) {
    throw new TypeError('Request headers are invalid')
  }
  if (cookiesSource !== undefined
    && (!cookiesSource || typeof cookiesSource !== 'object' || Array.isArray(cookiesSource))) {
    throw new TypeError('Request cookies are invalid')
  }
  return {
    headers: normalizeHeaders(headersSource ?? {}),
    cookies: normalizeCookies(cookiesSource)
  }
}

export function toAuthContext(req: ExpressLikeRequest, tenantId: TenantId): AuthContext {
  if (!isSafeContextText(tenantId, 512) || tenantId.length === 0) throw new TypeError('Resolved tenantId is invalid')
  const ip = req.ip
  const actorSource = req.authActor
  const metadataSource = req.authMetadata
  const policyInputSource = req.authPolicyInput
  const request = toHttpRequestView(req)
  if (ip !== undefined && !isSafeContextText(ip, 512)) throw new TypeError('Request IP is invalid')
  const actor = snapshotActor(actorSource)
  if (actorSource !== undefined && actor === undefined) throw new TypeError('Request actor is invalid')
  const metadata = metadataSource === undefined ? undefined : structuredClone(metadataSource)
  const policyInput = policyInputSource === undefined ? undefined : structuredClone(policyInputSource)
  if (!isPublicData(metadata) || !isPublicData(policyInput)) throw new TypeError('Request auth data is invalid')
  const requestId = boundedHeader(request.headers, 'x-request-id', 512)
  const userAgent = boundedHeader(request.headers, 'user-agent', 2048)
  const locale = boundedHeader(request.headers, 'accept-language', 128)
  return {
    tenantId,
    requestId,
    ip,
    userAgent,
    locale,
    actor,
    metadata,
    policyInput
  }
}

function normalizeHeaders(
  headers: NonNullable<ExpressLikeRequest['headers']>
): HttpRequestView['headers'] {
  const normalized: Array<[string, string | readonly string[] | undefined]> = []
  const names = new Set<string>()
  for (const [key, value] of Object.entries(headers)) {
    if (!safeInboundHeaderName(key) || !safeInboundHeaderValue(value)) {
      throw new TypeError('Request headers are invalid')
    }
    const name = key.toLowerCase()
    if (names.has(name)) throw new TypeError('Request headers are ambiguous')
    names.add(name)
    normalized.push([name, Array.isArray(value) ? [...value] : value])
  }
  return Object.fromEntries(normalized)
}

function firstHeader(headers: HttpRequestView['headers'], name: string): string | undefined {
  const lowerName = name.toLowerCase()
  const value = headers[name]
    ?? headers[lowerName]
    ?? Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)?.[1]
  return typeof value === 'string' ? value : value?.[0]
}

function boundedHeader(
  headers: HttpRequestView['headers'],
  name: string,
  maxLength: number
): string | undefined {
  const value = firstHeader(headers, name)
  if (value === undefined) return undefined
  if (!isSafeContextText(value, maxLength)) throw new TypeError(`Request ${name} header is invalid`)
  return value
}

function normalizeCookies(cookies: ExpressLikeRequest['cookies']): HttpRequestView['cookies'] {
  if (cookies === undefined) return undefined
  return Object.fromEntries(Object.entries(cookies).map(([name, value]) => {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || (value !== undefined && (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)))) {
      throw new TypeError('Request cookies are invalid')
    }
    return [name, value]
  }))
}

function safeInboundHeaderName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && (/^:[a-z0-9-]+$/.test(value) || /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value))
}

function safeInboundHeaderValue(value: unknown): value is string | readonly string[] | undefined {
  if (value === undefined) return true
  const values = Array.isArray(value) ? value : [value]
  return values.length <= 100 && values.every(isSafeHeaderValue)
}

function isActor(actor: unknown): actor is Actor {
  if (!isRecord(actor)) return false
  if (actor.type === 'anonymous') return hasOnlyKeys(actor, actorAnonymousKeys)
  if (actor.type === 'account') {
    return hasOnlyKeys(actor, actorAccountKeys)
      && isSafeContextText(actor.accountId, 512)
      && actor.accountId.length > 0
  }
  if (actor.type === 'system') {
    return hasOnlyKeys(actor, actorSystemKeys)
      && isSafeContextText(actor.name, 512)
      && actor.name.length > 0
  }
  return false
}

function snapshotActor(actor: unknown): Actor | undefined {
  if (actor === undefined || !isRecord(actor)) return undefined
  const type = actor.type
  const snapshot = type === 'anonymous' && hasOnlyKeys(actor, actorAnonymousKeys)
    ? { type }
    : type === 'account' && hasOnlyKeys(actor, actorAccountKeys)
      ? { type, accountId: actor.accountId }
      : type === 'system' && hasOnlyKeys(actor, actorSystemKeys)
        ? { type, name: actor.name }
        : undefined
  return isActor(snapshot) ? snapshot : undefined
}

function isPublicData(value: unknown): value is PublicData | undefined {
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
  if (!value || typeof value !== 'object' || value instanceof Date || depth >= 16 || state.visiting.has(value)) return false
  if (isSecretDescriptor(value)) return false
  if (hasFunction(value, 'reveal')
    || hasFunction(value, 'revealForPersistence')
    || hasFunction(value, 'revealCiphertextForPersistence')) return false
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
  if (!isSafeContextText(value, maxLength)) return false
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isSecretDescriptor(value: object): boolean {
  return !Array.isArray(value) && 'type' in value && secretDescriptorTypes.has(value.type)
}

type JsonTraversalState = {
  readonly visiting: Set<object>
  nodes: number
  characters: number
}
