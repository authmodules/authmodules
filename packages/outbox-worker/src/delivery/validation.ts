import type { PersistableDeliveryMessage } from '@authmodules/contracts/extensions'
import type { JsonValue } from '@authmodules/contracts/primitives'
import type { PersistableDeliveryData, SealedSecretValue } from '@authmodules/contracts/security'
import { areJsonValues, isJsonObject, isSafeText } from '../shared/json.ts'

const messageKeys = new Set(['data', 'locale', 'metadata', 'templateId', 'to'])
const addressKeys = new Set(['channel', 'display', 'target'])
const sealedSecretKeys = new Set([
  'algorithm',
  'expiresAt',
  'keyId',
  'redacted',
  'revealCiphertextForPersistence',
  'toJSON',
  'type'
])

export function isPersistedDeliveryMessage(message: unknown): message is PersistableDeliveryMessage {
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
    (message.data === undefined || isPersistedDeliveryData(message.data)) &&
    (message.metadata === undefined || isJsonObject(message.metadata))
}

export function snapshotPersistedDeliveryMessage(
  message: unknown
): PersistableDeliveryMessage | undefined {
  try {
    if (!isPlainObject(message)
      || !hasOnlyKeys(message, messageKeys)) return undefined
    const toSource = message.to
    if (!isPlainObject(toSource) || !hasOnlyKeys(toSource, addressKeys)) return undefined
    const channel = toSource.channel
    const target = toSource.target
    const display = toSource.display
    const templateId = message.templateId
    const locale = message.locale
    const dataSource = message.data
    const metadataSource = message.metadata
    const data = dataSource === undefined
      ? undefined
      : snapshotPersistedDeliveryData(dataSource, { secretCharacters: 0 })
    const metadata = metadataSource === undefined ? undefined : structuredClone(metadataSource)
    if ((dataSource !== undefined && data === undefined)
      || (metadata !== undefined && !isJsonObject(metadata))) return undefined
    const snapshot = {
      to: {
        channel,
        target,
        ...(display === undefined ? {} : { display })
      },
      templateId,
      ...(locale === undefined ? {} : { locale }),
      ...(data === undefined ? {} : { data }),
      ...(metadata === undefined ? {} : { metadata })
    }
    return isPersistedDeliveryMessage(snapshot) ? snapshot : undefined
  } catch {
    return undefined
  }
}

function snapshotPersistedDeliveryData(
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
    const publicValue = structuredClone(item)
    if (!areJsonValues([publicValue])) return undefined
    entries.push([key, publicValue as JsonValue])
  }
  return Object.fromEntries(entries)
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

function isPersistedDeliveryData(value: unknown): value is PersistableDeliveryData {
  if (!isPlainObject(value) || Object.keys(value).length > 1000) return false
  const publicValues = Object.values(value).filter((item) => !isSealedSecret(item))
  return areJsonValues(publicValues)
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
    && (value.expiresAt === undefined
      || (value.expiresAt instanceof Date && !Number.isNaN(value.expiresAt.getTime())))
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
