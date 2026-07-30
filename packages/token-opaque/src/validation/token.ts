import type { RawSecretValue, ProtectedValue } from '@authmodules/contracts/security'
import type { TokenIdentifyInput, TokenIssueInput } from '@authmodules/contracts/token'

const protectedValueKeys = new Set([
  'createdAt',
  'keyId',
  'redacted',
  'revealForPersistence',
  'scheme',
  'toJSON',
  'type'
])
const rawSecretKeys = new Set(['redacted', 'reveal', 'toJSON', 'type'])

export function validIssueInput(input?: TokenIssueInput): input is TokenIssueInput {
  try {
    if (!input
      || !nonEmptyString(input.tenantId)
      || !nonEmptyString(input.accountId)
      || !nonEmptyString(input.sessionId)) return false
    const issuedAt = dateTimestamp(input.issuedAt)
    const expiresAt = dateTimestamp(input.expiresAt)
    return issuedAt !== null && expiresAt !== null && expiresAt > issuedAt
  } catch {
    return false
  }
}

export function validIdentifyInput(input: TokenIdentifyInput | undefined, bytes: number): input is TokenIdentifyInput {
  try {
    return Boolean(input
      && nonEmptyString(input.expectedTenantId)
      && dateTimestamp(input.now) !== null
      && validRawToken(input.raw, bytes))
  } catch {
    return false
  }
}

export function validRawToken(raw: unknown, bytes: number): raw is RawSecretValue<string> {
  return snapshotRawToken(raw, bytes) !== null
}

export function snapshotRawToken(raw: unknown, bytes: number): RawSecretValue<string> | null {
  try {
    if (!isRecord(raw)
      || !hasOnlyKeys(raw, rawSecretKeys)
      || raw.type !== 'raw-secret'
      || typeof raw.redacted !== 'string'
      || typeof raw.reveal !== 'function'
      || typeof raw.toJSON !== 'function') return null
    const value = raw.reveal()
    if (typeof value !== 'string'
      || value.length !== Math.ceil(bytes * 4 / 3)
      || !/^[A-Za-z0-9_-]+$/.test(value)) return null
    return Object.freeze({
      type: 'raw-secret' as const,
      redacted: '[REDACTED]',
      reveal() {
        return value
      },
      toJSON() {
        return '[REDACTED]'
      }
    })
  } catch {
    return null
  }
}

export function snapshotTokenHash(value: unknown, scheme: string): ProtectedValue | null {
  try {
    if (!isRecord(value)
      || !hasOnlyKeys(value, protectedValueKeys)) return null
    const type = value.type
    const actualScheme = value.scheme
    const keyId = value.keyId
    const createdAtSource = value.createdAt
    const reveal = value.revealForPersistence
    const toJSON = value.toJSON
    let createdAtTime: number | undefined
    if (createdAtSource !== undefined) {
      if (!(createdAtSource instanceof Date)) return null
      createdAtTime = Date.prototype.getTime.call(createdAtSource)
      if (!Number.isFinite(createdAtTime)) return null
    }
    if (type !== 'protected-value'
      || actualScheme !== scheme
      || (keyId !== undefined && !nonEmptyString(keyId))
      || typeof reveal !== 'function'
      || typeof toJSON !== 'function') return null
    const persisted = reveal.call(value)
    if (typeof persisted !== 'string'
      || persisted.length === 0
      || persisted.length > 4096
      || /[\u0000-\u001f\u007f]/.test(persisted)) return null
    const createdAt = createdAtTime === undefined ? undefined : new Date(createdAtTime)
    return Object.freeze({
      type: 'protected-value' as const,
      scheme: actualScheme,
      redacted: '[REDACTED]',
      ...(keyId === undefined ? {} : { keyId }),
      ...(createdAt === undefined ? {} : { createdAt }),
      revealForPersistence() {
        return persisted
      },
      toJSON() {
        return '[REDACTED]'
      }
    })
  } catch {
    return null
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function dateTimestamp(value: unknown): number | null {
  if (!(value instanceof Date)) return null
  const timestamp = Date.prototype.getTime.call(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
