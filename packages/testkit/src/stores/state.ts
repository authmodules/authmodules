import type { ProtectedValue } from '@authmodules/contracts/security'
import type {
  AccountRecord,
  ChallengeRecord,
  CredentialRecord,
  IdentityRecord,
  SessionRecord
} from '@authmodules/contracts/store'
import type { TransactionContext, TransactionScope } from '@authmodules/contracts/transaction'
import { makeProtectedValue, makeSealedSecretValue } from '../secrets/factory.ts'

export type MemoryState = {
  accounts: Map<string, AccountRecord>
  identities: Map<string, IdentityRecord>
  identitySubjects: Map<string, string>
  credentials: Map<string, CredentialRecord>
  credentialsByIdentity: Map<string, string>
  sessions: Map<string, SessionRecord>
  sessionsByTokenHash: Map<string, string>
  challenges: Map<string, ChallengeRecord>
}

type MemoryStateKey = keyof MemoryState
type TransactionState = {
  readonly owner: MemoryState
  readonly working: MemoryState
}
const stateKeys: readonly MemoryStateKey[] = [
  'accounts',
  'identities',
  'identitySubjects',
  'credentials',
  'credentialsByIdentity',
  'sessions',
  'sessionsByTokenHash',
  'challenges'
]
const scopeStateKeys: Readonly<Record<string, readonly MemoryStateKey[]>> = {
  accounts: ['accounts'],
  identities: ['identities', 'identitySubjects'],
  credentials: ['credentials', 'credentialsByIdentity'],
  sessions: ['sessions', 'sessionsByTokenHash'],
  challenges: ['challenges']
}
const transactionStates = new WeakMap<TransactionContext, TransactionState>()
const protectedValueKeys = new Set([
  'createdAt',
  'keyId',
  'redacted',
  'revealForPersistence',
  'scheme',
  'toJSON',
  'type'
])
const sealedValueKeys = new Set([
  'algorithm',
  'expiresAt',
  'keyId',
  'redacted',
  'revealCiphertextForPersistence',
  'toJSON',
  'type'
])

export function isValidDate(value: unknown): value is Date {
  return dateTimestamp(value) !== undefined
}

export function snapshotDate(value: unknown): Date | undefined {
  const timestamp = dateTimestamp(value)
  return timestamp === undefined ? undefined : new Date(timestamp)
}

export function canTransitionAccountStatus(
  from: AccountRecord['status'],
  to: AccountRecord['status']
): boolean {
  if (from === 'active') return to === 'disabled' || to === 'deleted'
  if (from === 'disabled') return to === 'active' || to === 'deleted'
  return false
}

export function canTransitionCredentialStatus(
  from: CredentialRecord['status'],
  to: CredentialRecord['status']
): boolean {
  if (from === 'active') return to === 'disabled'
  if (from === 'disabled') return to === 'active'
  return false
}

export function createEmptyState(): MemoryState {
  return {
    accounts: new Map(),
    identities: new Map(),
    identitySubjects: new Map(),
    credentials: new Map(),
    credentialsByIdentity: new Map(),
    sessions: new Map(),
    sessionsByTokenHash: new Map(),
    challenges: new Map()
  }
}

export function cloneState(state: MemoryState): MemoryState {
  return {
    accounts: new Map(state.accounts),
    identities: new Map(state.identities),
    identitySubjects: new Map(state.identitySubjects),
    credentials: new Map(state.credentials),
    credentialsByIdentity: new Map(state.credentialsByIdentity),
    sessions: new Map(state.sessions),
    sessionsByTokenHash: new Map(state.sessionsByTokenHash),
    challenges: new Map(state.challenges)
  }
}

export function restoreState(state: MemoryState, snapshot: MemoryState): void {
  state.accounts = new Map(snapshot.accounts)
  state.identities = new Map(snapshot.identities)
  state.identitySubjects = new Map(snapshot.identitySubjects)
  state.credentials = new Map(snapshot.credentials)
  state.credentialsByIdentity = new Map(snapshot.credentialsByIdentity)
  state.sessions = new Map(snapshot.sessions)
  state.sessionsByTokenHash = new Map(snapshot.sessionsByTokenHash)
  state.challenges = new Map(snapshot.challenges)
}

export async function runWithTransactionState<T>(
  state: MemoryState,
  tx: TransactionContext,
  working: MemoryState,
  fn: () => Promise<T>
): Promise<T> {
  transactionStates.set(tx, { owner: state, working })
  try {
    return await fn()
  } finally {
    transactionStates.delete(tx)
  }
}

export function memoryStateFor(
  state: MemoryState,
  scope: TransactionScope,
  tx?: TransactionContext
): MemoryState | undefined {
  if (!tx) return state
  const transaction = transactionStates.get(tx)
  return transaction?.owner === state && tx.covers.includes(scope)
    ? transaction.working
    : undefined
}

export function canCommitTransactionState(
  state: MemoryState,
  before: MemoryState,
  working: MemoryState,
  scopes: readonly TransactionScope[]
): boolean {
  const coveredKeys = new Set(scopes.flatMap((scope) => scopeStateKeys[scope] ?? []))
  for (const key of coveredKeys) {
    if (!mapsMatch(
      state[key] as Map<string, unknown>,
      before[key] as Map<string, unknown>
    )) return false
  }
  const changes = stateKeys.map((key) => ({
    base: state[key] as Map<string, unknown>,
    before: before[key] as Map<string, unknown>,
    working: working[key] as Map<string, unknown>
  }))
  return !changes.some(({ base, before: snapshot, working: transaction }) => (
    hasConflict(base, snapshot, transaction)
  ))
}

function mapsMatch(
  left: Map<string, unknown>,
  right: Map<string, unknown>
): boolean {
  if (left.size !== right.size) return false
  for (const key of left.keys()) {
    if (!entryMatches(left, right, key)) return false
  }
  return true
}

export function applyTransactionState(
  state: MemoryState,
  before: MemoryState,
  working: MemoryState
): void {
  const changes = stateKeys.map((key) => ({
    base: state[key] as Map<string, unknown>,
    before: before[key] as Map<string, unknown>,
    working: working[key] as Map<string, unknown>
  }))
  for (const { base, before: snapshot, working: transaction } of changes) {
    applyChanges(base, snapshot, transaction)
  }
}

function hasConflict(
  base: Map<string, unknown>,
  before: Map<string, unknown>,
  working: Map<string, unknown>
): boolean {
  for (const key of new Set([...before.keys(), ...working.keys()])) {
    if (!entryMatches(before, working, key) && !entryMatches(before, base, key)) return true
  }
  return false
}

function applyChanges(
  base: Map<string, unknown>,
  before: Map<string, unknown>,
  working: Map<string, unknown>
): void {
  for (const key of new Set([...before.keys(), ...working.keys()])) {
    if (entryMatches(before, working, key)) continue
    if (working.has(key)) {
      base.set(key, working.get(key))
    } else {
      base.delete(key)
    }
  }
}

function entryMatches(
  left: Map<string, unknown>,
  right: Map<string, unknown>,
  key: string
): boolean {
  return left.has(key) === right.has(key) && left.get(key) === right.get(key)
}

export function accountKey(tenantId: string, accountId: string): string {
  return `${tenantId}\u0000${accountId}`
}

export function identityKey(tenantId: string, identityId: string): string {
  return `${tenantId}\u0000${identityId}`
}

export function identitySubjectKey(tenantId: string, methodId: string, subject: string): string {
  return `${tenantId}\u0000${methodId}\u0000${subject}`
}

export function credentialKey(tenantId: string, credentialId: string): string {
  return `${tenantId}\u0000${credentialId}`
}

export function credentialIdentityKey(tenantId: string, identityId: string, methodId: string): string {
  return `${tenantId}\u0000${identityId}\u0000${methodId}`
}

export function sessionKey(tenantId: string, sessionId: string): string {
  return `${tenantId}\u0000${sessionId}`
}

export function challengeKey(tenantId: string, challengeId: string): string {
  return `${tenantId}\u0000${challengeId}`
}

export function tokenHashKey(tenantId: string, tokenHash: ProtectedValue): string | null {
  try {
    const scheme = tokenHash?.scheme
    const keyId = tokenHash?.keyId ?? ''
    const verifier = tokenHash?.revealForPersistence?.()
    if (typeof tenantId !== 'string' || tenantId.length === 0
      || typeof scheme !== 'string' || scheme.length === 0
      || typeof keyId !== 'string'
      || typeof verifier !== 'string' || verifier.length === 0) {
      return null
    }
    return JSON.stringify([tenantId, scheme, keyId, verifier])
  } catch {
    return null
  }
}

export function cloneRecord<T>(value: T): T {
  if (value === undefined || value === null) {
    return value
  }

  if (value instanceof Date) {
    return new Date(value) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneRecord(item)) as T
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const type = 'type' in record ? record.type : undefined
    if (type === 'protected-value') {
      if (!Object.keys(record).every((key) => protectedValueKeys.has(key))) {
        throw new TypeError('Protected value is invalid')
      }
      const scheme = record.scheme
      const keyId = record.keyId
      const createdAt = record.createdAt
      const reveal = record.revealForPersistence
      const toJSON = record.toJSON
      if (typeof scheme !== 'string'
        || (keyId !== undefined && typeof keyId !== 'string')
        || (createdAt !== undefined && !isValidDate(createdAt))
        || typeof reveal !== 'function'
        || typeof toJSON !== 'function') throw new TypeError('Protected value is invalid')
      const verifier = reveal.call(record)
      if (typeof verifier !== 'string' || verifier.length === 0 || verifier.length > 5_000_000) {
        throw new TypeError('Protected value is invalid')
      }
      return makeProtectedValue({
        type: 'protected-value',
        scheme,
        value: verifier,
        keyId,
        createdAt: createdAt === undefined ? undefined : new Date(createdAt)
      }) as T
    }
    if (type === 'sealed-secret') {
      if (!Object.keys(record).every((key) => sealedValueKeys.has(key))) {
        throw new TypeError('Sealed value is invalid')
      }
      const algorithm = record.algorithm
      const keyId = record.keyId
      const expiresAt = record.expiresAt
      const reveal = record.revealCiphertextForPersistence
      const toJSON = record.toJSON
      if (typeof algorithm !== 'string'
        || typeof keyId !== 'string'
        || (expiresAt !== undefined && !isValidDate(expiresAt))
        || typeof reveal !== 'function'
        || typeof toJSON !== 'function') throw new TypeError('Sealed value is invalid')
      const ciphertext = reveal.call(record)
      if (typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext.length > 5_000_000) {
        throw new TypeError('Sealed value is invalid')
      }
      return makeSealedSecretValue({
        type: 'sealed-secret',
        ciphertext,
        algorithm,
        keyId,
        expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt)
      }) as T
    }
    if (type === 'raw-secret') return { type: 'raw-secret' } as T
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneRecord(item)])) as T
  }

  return value
}

export function snapshotRecord<T>(
  value: unknown,
  validator: (candidate: unknown) => candidate is T
): T | undefined {
  try {
    const snapshot = cloneRecord(value)
    return validator(snapshot) ? snapshot : undefined
  } catch {
    return undefined
  }
}

function dateTimestamp(value: unknown): number | undefined {
  try {
    if (!(value instanceof Date)) return undefined
    const timestamp = Date.prototype.getTime.call(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  } catch {
    return undefined
  }
}
