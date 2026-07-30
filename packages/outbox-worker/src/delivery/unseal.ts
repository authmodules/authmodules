import type { SecretSealer } from '@authmodules/contracts/crypto'
import type { DeliveryMessage } from '@authmodules/contracts/delivery'
import type { DeliveryFailure } from '@authmodules/contracts/errors'
import type { LeasedOutboxMessage } from '@authmodules/contracts/extensions'
import type { JsonValue } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type { DeliveryData, RawSecretValue, SealedSecretValue } from '@authmodules/contracts/security'
import { deliveryFailure } from '../shared/result.ts'

export async function unsealDeliveryMessage(
  sealer: SecretSealer,
  outboxMessage: LeasedOutboxMessage,
  now: Date
): Promise<Result<DeliveryMessage, DeliveryFailure>> {
  try {
    if (outboxMessage.expiresAt && outboxMessage.expiresAt <= now) {
      return deliveryFailure()
    }
    const message = outboxMessage.message
    const data = message.data === undefined
      ? undefined
      : await unsealDeliveryData(sealer, message.data, outboxMessage.secretPurpose, now)
    return {
      ok: true,
      value: {
        to: { ...message.to },
        templateId: message.templateId,
        locale: message.locale,
        metadata: message.metadata === undefined ? undefined : structuredClone(message.metadata),
        data
      }
    }
  } catch {
    return deliveryFailure()
  }
}

async function unsealDeliveryData(
  sealer: SecretSealer,
  data: NonNullable<LeasedOutboxMessage['message']['data']>,
  purpose: string,
  now: Date
): Promise<DeliveryData> {
  const entries: Array<[string, JsonValue | RawSecretValue<string>]> = []
  const budget = { secretCharacters: 0 }
  for (const [key, value] of Object.entries(data)) {
    if (isSealedSecret(value)) {
      const unsealed = await sealer.unseal<string>({ value, purpose, now })
      if (!unsealed.ok) throw new Error('Secret unseal failed')
      const snapshot = snapshotRawStringSecret(unsealed.value, budget)
      if (!snapshot) throw new Error('Secret unseal failed')
      entries.push([key, snapshot])
    } else {
      entries.push([key, value])
    }
  }
  return Object.fromEntries(entries)
}

function snapshotRawStringSecret(
  value: unknown,
  budget: { secretCharacters: number }
): RawSecretValue<string> | undefined {
  if (!isRecord(value)
    || value.type !== 'raw-secret'
    || typeof value.redacted !== 'string'
    || typeof value.reveal !== 'function'
    || typeof value.toJSON !== 'function') return undefined
  const revealed = value.reveal()
  if (typeof revealed !== 'string' || revealed.length === 0) return undefined
  budget.secretCharacters += revealed.length
  if (budget.secretCharacters > 1_000_000) return undefined
  return Object.freeze({
    type: 'raw-secret' as const,
    redacted: '[REDACTED]',
    reveal: () => revealed,
    toJSON: () => '[REDACTED]'
  })
}

function isSealedSecret(value: unknown): value is SealedSecretValue {
  return isRecord(value)
    && value.type === 'sealed-secret'
    && typeof value.algorithm === 'string'
    && typeof value.keyId === 'string'
    && typeof value.redacted === 'string'
    && typeof value.revealCiphertextForPersistence === 'function'
    && typeof value.toJSON === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
