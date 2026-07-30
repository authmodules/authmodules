import type { SecretSealer } from '@authmodules/contracts/crypto'
import type { DeliveryMessage } from '@authmodules/contracts/delivery'
import type { PersistableDeliveryMessage } from '@authmodules/contracts/extensions'
import type { Result } from '@authmodules/contracts/result'
import type { PersistableDeliveryData, RawSecretValue, SealedSecretValue } from '@authmodules/contracts/security'
import { outboxSecretPurpose } from './outbox-secret-purpose.ts'
import { toPersistableDeliveryMessage } from './persist.ts'
import { isDeliveryData, isDeliveryMessage } from './validation.ts'
import { isSafeText, isValidDate } from '../shared/json.ts'

type SealDeliveryMessageInput = {
  readonly message: DeliveryMessage
  readonly sealer: SecretSealer
  readonly tenantId: string
  readonly messageId: string
  readonly expiresAt?: Date
}

const sealResultKeys = new Set(['ok', 'value'])
const sealedSecretKeys = new Set([
  'algorithm',
  'expiresAt',
  'keyId',
  'redacted',
  'revealCiphertextForPersistence',
  'toJSON',
  'type'
])

export async function sealDeliveryMessage(
  input: SealDeliveryMessageInput
): Promise<Result<PersistableDeliveryMessage, 'raw-secret'>> {
  try {
    const message = input.message
    if (!isDeliveryMessage(message) || (message.data !== undefined && !isDeliveryData(message.data, 'raw'))) {
      throw new TypeError('Delivery message is invalid')
    }
    const data = message.data === undefined ? undefined : await sealDeliveryData(input, message.data)
    return toPersistableDeliveryMessage({ ...message, data })
  } catch {
    return { ok: false, error: 'raw-secret' }
  }
}

async function sealDeliveryData(
  input: SealDeliveryMessageInput,
  data: NonNullable<DeliveryMessage['data']>
): Promise<PersistableDeliveryData> {
  const entries: Array<[string, PersistableDeliveryData[string]]> = []
  for (const [key, value] of Object.entries(data)) {
    if (isRawSecret(value)) {
      const sealed = await input.sealer.seal({
        value,
        purpose: outboxSecretPurpose(input.tenantId, input.messageId),
        expiresAt: input.expiresAt === undefined ? undefined : new Date(input.expiresAt.getTime())
      })
      const snapshot = snapshotSealedResult(sealed)
      if (!snapshot) throw new Error('Secret sealing failed')
      entries.push([key, snapshot])
    } else {
      entries.push([key, value])
    }
  }
  return Object.fromEntries(entries)
}

function isRawSecret(value: unknown): value is RawSecretValue {
  return isRecord(value)
    && value.type === 'raw-secret'
    && typeof value.redacted === 'string'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
}

function snapshotSealedResult(value: unknown): SealedSecretValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, sealResultKeys)) return undefined
  const ok = value.ok
  const candidate = value.value
  if (ok !== true || !isRecord(candidate) || !hasOnlyKeys(candidate, sealedSecretKeys)) return undefined
  const type = candidate.type
  const algorithm = candidate.algorithm
  const keyId = candidate.keyId
  const expiresAt = candidate.expiresAt
  const reveal = candidate.revealCiphertextForPersistence
  const toJSON = candidate.toJSON
  if (type !== 'sealed-secret'
    || !isSafeText(algorithm, 256) || algorithm.length === 0
    || !isSafeText(keyId, 512) || keyId.length === 0
    || (expiresAt !== undefined && !isValidDate(expiresAt))
    || typeof reveal !== 'function'
    || typeof toJSON !== 'function') return undefined
  const ciphertext = reveal.call(candidate)
  if (typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext.length > 5_000_000) return undefined
  return Object.freeze({
    type: 'sealed-secret' as const,
    algorithm,
    keyId,
    redacted: '[REDACTED]',
    ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt.getTime()) }),
    revealCiphertextForPersistence: () => ciphertext,
    toJSON: () => '[REDACTED]'
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
