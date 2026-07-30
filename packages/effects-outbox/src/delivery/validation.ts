import type { DeliveryMessage } from '@authmodules/contracts/delivery'
import type { DeliverySideEffectRequest } from '@authmodules/contracts/effects'
import type { PersistableDeliveryMessage } from '@authmodules/contracts/extensions'
import type { JsonValue } from '@authmodules/contracts/primitives'
import type { DeliveryData, PersistableDeliveryData, RawSecretValue, SealedSecretValue } from '@authmodules/contracts/security'
import { isJsonObject, isJsonValue, isSafeText, isValidDate } from '../shared/json.ts'

const effectKeys = new Set(['dispatchPolicy', 'expiresAt', 'idempotencyKey', 'message', 'type'])
const messageKeys = new Set(['data', 'locale', 'metadata', 'templateId', 'to'])
const addressKeys = new Set(['channel', 'display', 'target'])
const rawSecretKeys = new Set(['redacted', 'reveal', 'toJSON', 'type'])
const sealedSecretKeys = new Set([
  'algorithm',
  'expiresAt',
  'keyId',
  'redacted',
  'revealCiphertextForPersistence',
  'toJSON',
  'type'
])

export function isDeliveryEffect(effect: unknown): effect is DeliverySideEffectRequest {
  return isPlainObject(effect)
    && hasOnlyKeys(effect, effectKeys)
    && effect.type === 'delivery' &&
    (effect.dispatchPolicy === 'required' || effect.dispatchPolicy === 'best-effort') &&
    isDeliveryMessage(effect.message) &&
    (effect.idempotencyKey === undefined
      ? effect.dispatchPolicy === 'best-effort'
      : isSafeText(effect.idempotencyKey, 512) && effect.idempotencyKey.length > 0) &&
    (effect.expiresAt === undefined || isValidDate(effect.expiresAt))
}

export function snapshotDeliveryEffect(effect: unknown): DeliverySideEffectRequest | undefined {
  try {
    if (!isPlainObject(effect) || !hasOnlyKeys(effect, effectKeys)) return undefined
    const type = effect.type
    const dispatchPolicy = effect.dispatchPolicy
    const idempotencyKey = effect.idempotencyKey
    const expiresAtSource = effect.expiresAt
    const expiresAt = snapshotOptionalDate(expiresAtSource)
    const message = snapshotDeliveryMessage(effect.message)
    const snapshot = {
      type,
      dispatchPolicy,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      message
    }
    if (expiresAtSource !== undefined && expiresAt === undefined) return undefined
    return isDeliveryEffect(snapshot) ? snapshot : undefined
  } catch {
    return undefined
  }
}

export function isDeliveryMessage(message: unknown): message is DeliveryMessage {
  return isPlainObject(message)
    && isPlainObject(message.to)
    && hasOnlyKeys(message, messageKeys)
    && hasOnlyKeys(message.to, addressKeys)
    && isSafeText(message.to.channel, 64) &&
    message.to.channel.length > 0 &&
    isSafeText(message.to.target, 2048) &&
    message.to.target.length > 0 &&
    (message.to.display === undefined || isSafeText(message.to.display, 512)) &&
    isSafeText(message.templateId, 256) &&
    message.templateId.length > 0 &&
    (message.locale === undefined || (isSafeText(message.locale, 128) && message.locale.length > 0)) &&
    (message.data === undefined || (message.data !== null && typeof message.data === 'object' && !Array.isArray(message.data))) &&
    (message.metadata === undefined || isJsonObject(message.metadata))
}

function snapshotDeliveryMessage(message: unknown): DeliveryMessage | undefined {
  if (!isPlainObject(message) || !hasOnlyKeys(message, messageKeys)) return undefined
  const to = message.to
  if (!isPlainObject(to) || !hasOnlyKeys(to, addressKeys)) return undefined
  const channel = to.channel
  const target = to.target
  const display = to.display
  const templateId = message.templateId
  const locale = message.locale
  const dataCandidate = message.data
  const metadataCandidate = message.metadata
  const address = {
    channel,
    target,
    ...(display === undefined ? {} : { display })
  }
  const data = dataCandidate === undefined
    ? undefined
    : snapshotDeliveryData(dataCandidate, { secretCharacters: 0 })
  const metadata = metadataCandidate === undefined ? undefined : snapshotJsonObject(metadataCandidate)
  if ((dataCandidate !== undefined && data === undefined)
    || (metadataCandidate !== undefined && metadata === undefined)) return undefined
  const snapshot = {
    to: address,
    templateId,
    ...(locale === undefined ? {} : { locale }),
    ...(data === undefined ? {} : { data }),
    ...(metadata === undefined ? {} : { metadata })
  }
  return isDeliveryMessage(snapshot)
    && (snapshot.data === undefined || isDeliveryData(snapshot.data, 'raw'))
    ? snapshot
    : undefined
}

function snapshotDeliveryData(
  value: unknown,
  budget: { secretCharacters: number }
): DeliveryData | undefined {
  if (!isPlainObject(value) || Object.keys(value).length > 1000) return undefined
  const entries: Array<[string, DeliveryData[string]]> = []
  for (const [key, item] of Object.entries(value)) {
    const secret = snapshotRawSecret(item, budget)
    if (secret) {
      entries.push([key, secret])
      continue
    }
    const json = snapshotJsonValue(item)
    if (json === undefined) return undefined
    entries.push([key, json])
  }
  const snapshot = Object.fromEntries(entries)
  return isDeliveryData(snapshot, 'raw') ? snapshot : undefined
}

function snapshotRawSecret(
  value: unknown,
  budget: { secretCharacters: number }
): RawSecretValue | undefined {
  if (!isPlainObject(value) || !hasOnlyKeys(value, rawSecretKeys)) return undefined
  const type = value.type
  const reveal = value.reveal
  const toJSON = value.toJSON
  if (type !== 'raw-secret' || typeof reveal !== 'function' || typeof toJSON !== 'function') return undefined
  const revealed = reveal.call(value)
  if (typeof revealed !== 'string' || revealed.length === 0) return undefined
  budget.secretCharacters += revealed.length
  if (budget.secretCharacters > 1_000_000) return undefined
  const secret = revealed
  return Object.freeze({
    type: 'raw-secret' as const,
    redacted: '[REDACTED]',
    reveal: () => secret,
    toJSON: () => '[REDACTED]'
  })
}

export function snapshotPersistableDeliveryMessage(
  message: unknown
): PersistableDeliveryMessage | undefined {
  try {
    if (!isPlainObject(message) || !hasOnlyKeys(message, messageKeys)) return undefined
    const toSource = message.to
    if (!isPlainObject(toSource) || !hasOnlyKeys(toSource, addressKeys)) return undefined
    const channel = toSource.channel
    const target = toSource.target
    const display = toSource.display
    const templateId = message.templateId
    const locale = message.locale
    const dataCandidate = message.data
    const metadataCandidate = message.metadata
    const data = dataCandidate === undefined
      ? undefined
      : snapshotPersistableDeliveryData(dataCandidate, { secretCharacters: 0 })
    const metadata = metadataCandidate === undefined ? undefined : snapshotJsonObject(metadataCandidate)
    if ((dataCandidate !== undefined && data === undefined)
      || (metadataCandidate !== undefined && metadata === undefined)) return undefined
    const snapshot = {
      to: {
        channel,
        target,
        ...(display === undefined ? {} : { display })
      },
      templateId,
      ...(locale === undefined ? {} : { locale }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(data === undefined ? {} : { data })
    }
    return isDeliveryMessage(snapshot)
      && (snapshot.data === undefined || isDeliveryData(snapshot.data, 'sealed'))
      ? snapshot
      : undefined
  } catch {
    return undefined
  }
}

function snapshotPersistableDeliveryData(
  value: unknown,
  budget: { secretCharacters: number }
): PersistableDeliveryData | undefined {
  if (!isPlainObject(value) || Object.keys(value).length > 1000) return undefined
  const entries: Array<[string, PersistableDeliveryData[string]]> = []
  for (const [key, item] of Object.entries(value)) {
    const secret = snapshotSealedSecret(item, budget)
    if (secret) {
      entries.push([key, secret])
      continue
    }
    const json = snapshotJsonValue(item)
    if (json === undefined) return undefined
    entries.push([key, json])
  }
  const snapshot = Object.fromEntries(entries)
  return isDeliveryData(snapshot, 'sealed') ? snapshot : undefined
}

function snapshotSealedSecret(
  value: unknown,
  budget: { secretCharacters: number }
): SealedSecretValue | undefined {
  if (!isPlainObject(value) || !hasOnlyKeys(value, sealedSecretKeys)) return undefined
  const type = value.type
  const algorithm = value.algorithm
  const keyId = value.keyId
  const expiresAtSource = value.expiresAt
  const expiresAt = snapshotOptionalDate(expiresAtSource)
  const revealCiphertextForPersistence = value.revealCiphertextForPersistence
  const toJSON = value.toJSON
  if (type !== 'sealed-secret'
    || !isSafeText(algorithm, 256)
    || !isSafeText(keyId, 512)
    || (expiresAtSource !== undefined && expiresAt === undefined)
    || typeof revealCiphertextForPersistence !== 'function'
    || typeof toJSON !== 'function') return undefined
  const ciphertext = revealCiphertextForPersistence.call(value)
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return undefined
  budget.secretCharacters += ciphertext.length
  if (budget.secretCharacters > 1_000_000) return undefined
  return Object.freeze({
    type: 'sealed-secret' as const,
    algorithm,
    keyId,
    redacted: '[REDACTED]',
    expiresAt,
    revealCiphertextForPersistence: () => ciphertext,
    toJSON: () => '[REDACTED]'
  })
}

function snapshotOptionalDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof Date)) return undefined
  const timestamp = Date.prototype.getTime.call(value)
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined
}

function snapshotJsonObject(value: unknown): DeliveryMessage['metadata'] | undefined {
  const snapshot = structuredClone(value)
  return isJsonObject(snapshot) ? snapshot : undefined
}

function snapshotJsonValue(value: unknown): JsonValue | undefined {
  const snapshot = structuredClone(value)
  return isJsonValue(snapshot) ? snapshot : undefined
}

export function isDeliveryData(value: unknown, secretKind: 'raw'): value is DeliveryData
export function isDeliveryData(value: unknown, secretKind: 'sealed'): value is PersistableDeliveryData
export function isDeliveryData(value: unknown, secretKind: 'raw' | 'sealed'): boolean {
  if (!isPlainObject(value) || Object.keys(value).length > 1000) return false
  return Object.values(value).every((item) => {
    if (secretKind === 'raw' && isRawSecret(item)) return true
    if (secretKind === 'sealed' && isSealedSecret(item)) return true
    return isJsonValue(item)
  })
}

function isRawSecret(value: unknown): value is RawSecretValue {
  return isPlainObject(value)
    && hasOnlyKeys(value, rawSecretKeys)
    && value.type === 'raw-secret'
    && typeof value.redacted === 'string'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
    && !('revealForPersistence' in value)
    && !('revealCiphertextForPersistence' in value)
}

function isSealedSecret(value: unknown): value is SealedSecretValue {
  return isPlainObject(value)
    && hasOnlyKeys(value, sealedSecretKeys)
    && value.type === 'sealed-secret'
    && isSafeText(value.algorithm, 256)
    && value.algorithm.length > 0
    && isSafeText(value.keyId, 512)
    && value.keyId.length > 0
    && typeof value.redacted === 'string'
    && (value.expiresAt === undefined || isValidDate(value.expiresAt))
    && typeof value.revealCiphertextForPersistence === 'function'
    && typeof value.toJSON === 'function'
    && !('reveal' in value)
    && !('revealForPersistence' in value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
