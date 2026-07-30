import { createHash, timingSafeEqual } from 'node:crypto'
import type { SecretSealer } from '@authmodules/contracts/crypto'
import type { DeliveryMessage } from '@authmodules/contracts/delivery'
import type { DeliverySideEffectRequest, SideEffectDispatchItem } from '@authmodules/contracts/effects'
import type { OutboxMessage, PersistableDeliveryMessage } from '@authmodules/contracts/extensions'
import type { RawSecretValue, SealedSecretValue } from '@authmodules/contracts/security'

type PreparedOutboxEffect = {
  readonly item: SideEffectDispatchItem
  readonly effect: DeliverySideEffectRequest
  readonly outboxMessage: OutboxMessage
}

type VerifyEnqueueAcknowledgementsInput = {
  readonly sealer: SecretSealer
  readonly prepared: readonly PreparedOutboxEffect[]
  readonly acknowledged: readonly OutboxMessage[]
  readonly now: Date
}

const resultKeys = new Set(['ok', 'value'])
const rawSecretKeys = new Set(['redacted', 'reveal', 'toJSON', 'type'])

export async function verifyEnqueueAcknowledgements(
  input: VerifyEnqueueAcknowledgementsInput
): Promise<boolean> {
  try {
    if (input.prepared.length !== input.acknowledged.length) return false
    for (const [index, prepared] of input.prepared.entries()) {
      const acknowledged = input.acknowledged[index]
      if (!acknowledged || !await isMatchingAcknowledgement({
        sealer: input.sealer,
        prepared,
        acknowledged,
        now: input.now
      })) return false
    }
    return true
  } catch {
    return false
  }
}

async function isMatchingAcknowledgement(input: {
  readonly sealer: SecretSealer
  readonly prepared: PreparedOutboxEffect
  readonly acknowledged: OutboxMessage
  readonly now: Date
}): Promise<boolean> {
  const { acknowledged, prepared } = input
  const expected = prepared.outboxMessage
  if (acknowledged.status === 'dead'
    || acknowledged.dispatchPolicy !== expected.dispatchPolicy
    || acknowledged.maxAttempts !== expected.maxAttempts
    || !sameOptionalDate(acknowledged.expiresAt, expected.expiresAt)
    || (acknowledged.expiresAt !== undefined
      && dateTimestamp(acknowledged.expiresAt) <= dateTimestamp(input.now))
    || !sameJsonValue(acknowledged.context, expected.context)) return false

  if (acknowledged.messageId === expected.messageId
    && samePersistableDeliveryMessage(acknowledged.message, expected.message)) {
    return true
  }
  if (expected.idempotencyKey === undefined) return false
  return sameLogicalDeliveryMessage({
    sealer: input.sealer,
    persisted: acknowledged.message,
    expected: prepared.effect.message,
    purpose: acknowledged.secretPurpose,
    now: input.now
  })
}

async function sameLogicalDeliveryMessage(input: {
  readonly sealer: SecretSealer
  readonly persisted: PersistableDeliveryMessage
  readonly expected: DeliveryMessage
  readonly purpose: string
  readonly now: Date
}): Promise<boolean> {
  if (!sameDeliveryEnvelope(input.persisted, input.expected)) return false
  const persistedData = input.persisted.data
  const expectedData = input.expected.data
  if (persistedData === undefined || expectedData === undefined) {
    return persistedData === expectedData
  }
  const persistedKeys = Object.keys(persistedData)
  const expectedKeys = Object.keys(expectedData)
  if (!sameKeys(persistedKeys, expectedKeys)) return false
  const persistedBudget = { secretCharacters: 0 }
  const expectedBudget = { secretCharacters: 0 }
  for (const key of persistedKeys) {
    const persistedValue = persistedData[key]
    const expectedValue = expectedData[key]
    if (isSealedSecret(persistedValue)) {
      if (!isRawSecret(expectedValue)) return false
      const unsealed = await input.sealer.unseal<string>({
        value: persistedValue,
        purpose: input.purpose,
        now: new Date(dateTimestamp(input.now))
      })
      const actualSecret = snapshotUnsealedSecret(unsealed, persistedBudget)
      const expectedSecret = snapshotRawSecret(expectedValue, expectedBudget)
      if (actualSecret === undefined
        || expectedSecret === undefined
        || !sameSecretText(actualSecret, expectedSecret)) return false
      continue
    }
    if (isRawSecret(expectedValue) || !sameJsonValue(persistedValue, expectedValue)) return false
  }
  return true
}

function samePersistableDeliveryMessage(
  actual: PersistableDeliveryMessage,
  expected: PersistableDeliveryMessage
): boolean {
  if (!sameDeliveryEnvelope(actual, expected)) return false
  const actualData = actual.data
  const expectedData = expected.data
  if (actualData === undefined || expectedData === undefined) return actualData === expectedData
  const actualKeys = Object.keys(actualData)
  const expectedKeys = Object.keys(expectedData)
  if (!sameKeys(actualKeys, expectedKeys)) return false
  for (const key of actualKeys) {
    const actualValue = actualData[key]
    const expectedValue = expectedData[key]
    if (isSealedSecret(actualValue) || isSealedSecret(expectedValue)) {
      if (!isSealedSecret(actualValue)
        || !isSealedSecret(expectedValue)
        || !samePersistedSecret(actualValue, expectedValue)) return false
      continue
    }
    if (!sameJsonValue(actualValue, expectedValue)) return false
  }
  return true
}

function sameDeliveryEnvelope(
  actual: PersistableDeliveryMessage | DeliveryMessage,
  expected: PersistableDeliveryMessage | DeliveryMessage
): boolean {
  return actual.to.channel === expected.to.channel
    && actual.to.target === expected.to.target
    && actual.to.display === expected.to.display
    && actual.templateId === expected.templateId
    && actual.locale === expected.locale
    && sameJsonValue(actual.metadata, expected.metadata)
}

function samePersistedSecret(actual: SealedSecretValue, expected: SealedSecretValue): boolean {
  const actualCiphertext = actual.revealCiphertextForPersistence()
  const expectedCiphertext = expected.revealCiphertextForPersistence()
  return actual.algorithm === expected.algorithm
    && actual.keyId === expected.keyId
    && sameOptionalDate(actual.expiresAt, expected.expiresAt)
    && typeof actualCiphertext === 'string'
    && actualCiphertext.length > 0
    && actualCiphertext.length <= 5_000_000
    && typeof expectedCiphertext === 'string'
    && expectedCiphertext.length > 0
    && expectedCiphertext.length <= 5_000_000
    && sameSecretText(actualCiphertext, expectedCiphertext)
}

function snapshotUnsealedSecret(
  value: unknown,
  budget: { secretCharacters: number }
): string | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, resultKeys) || value.ok !== true) return undefined
  return snapshotRawSecret(value.value, budget)
}

function snapshotRawSecret(
  value: unknown,
  budget: { secretCharacters: number }
): string | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, rawSecretKeys)) return undefined
  const type = value.type
  const reveal = value.reveal
  const toJSON = value.toJSON
  if (type !== 'raw-secret' || typeof reveal !== 'function' || typeof toJSON !== 'function') return undefined
  const revealed = reveal.call(value)
  if (typeof revealed !== 'string' || revealed.length === 0) return undefined
  budget.secretCharacters += revealed.length
  return budget.secretCharacters <= 1_000_000 ? revealed : undefined
}

function isRawSecret(value: unknown): value is RawSecretValue<string> {
  return isRecord(value)
    && value.type === 'raw-secret'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
}

function isSealedSecret(value: unknown): value is SealedSecretValue {
  return isRecord(value)
    && value.type === 'sealed-secret'
    && typeof value.revealCiphertextForPersistence === 'function'
    && typeof value.toJSON === 'function'
}

function sameOptionalDate(actual: Date | undefined, expected: Date | undefined): boolean {
  return actual === undefined || expected === undefined
    ? actual === expected
    : dateTimestamp(actual) === dateTimestamp(expected)
}

function dateTimestamp(value: Date): number {
  return Date.prototype.getTime.call(value)
}

function sameSecretText(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(actualDigest, expectedDigest)
}

function sameJsonValue(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual)
      && Array.isArray(expected)
      && actual.length === expected.length
      && actual.every((item, index) => sameJsonValue(item, expected[index]))
  }
  if (!isRecord(actual) || !isRecord(expected)) return false
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  return sameKeys(actualKeys, expectedKeys)
    && actualKeys.every((key) => sameJsonValue(actual[key], expected[key]))
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
