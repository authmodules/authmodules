import type {
  CreateAuthConfig,
  GetSessionInput,
  RevokeSessionInput,
  SessionConfig
} from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type { AccountId, AuthContext, AuthProof, CreateSessionRequest } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type { ProtectedValue } from '@authmodules/contracts/security'
import type { SessionRecord } from '@authmodules/contracts/store'
import type { TransactionContext } from '@authmodules/contracts/transaction'
import type { IssuedTokenView } from '@authmodules/contracts/token'
import type { SessionView } from '@authmodules/contracts/views'
import { emitEvent } from '../events/emit.ts'
import { policy } from '../policy/check.ts'
import { authContextFrom, isAuthContext, isNonEmptyString, isValidDate } from '../validation/input.ts'
import {
  isRawSecret,
  snapshotProtectedValue,
  snapshotRawSecret,
  isTokenIdentifyCallResult,
  isTokenIssueCallResult
} from '../validation/token.ts'
import { isAccountRecord, isSessionRecord } from '../validation/store.ts'
import { toSessionView } from '../views/records.ts'
import { authErr, storeFailure } from '../shared/errors.ts'
import { generateCoreId } from '../shared/id.ts'
import { ok } from '../shared/result.ts'
import { readNow } from '../shared/time.ts'

export type CreatedSession = {
  readonly session: SessionView
  readonly token: IssuedTokenView
}

export async function getSession(
  config: CreateAuthConfig,
  input: unknown
): Promise<Result<SessionView | null, AuthFailure>> {
  if (!isGetSessionInput(input)) {
    return authErr(authContextFrom(input), 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  if (!input.token) {
    return ok(null)
  }

  const now = readNow(config)
  if (!now) {
    return authErr(input.context, 'INTERNAL', 'INTERNAL')
  }
  let identified: unknown
  try {
    identified = await config.token.identify({
      raw: input.token,
      expectedTenantId: input.context.tenantId,
      now: new Date(now.getTime())
    })
  } catch {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!isTokenIdentifyCallResult(identified)) {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!identified.ok) {
    return authErr(input.context, identified.error.reason, 'TEMPORARILY_UNAVAILABLE')
  }
  if (!identified.value) {
    return ok(null)
  }
  const tokenHash = snapshotProtectedValue(identified.value.tokenHash)
  if (!tokenHash) {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }

  if (identified.value.kind === 'by-session' && identified.value.tenantId !== input.context.tenantId) {
    return ok(null)
  }

  const found = identified.value.kind === 'by-session'
    ? await config.store.session.sessions.findById({
      tenantId: input.context.tenantId,
      sessionId: identified.value.sessionId
    })
    : await config.store.session.sessions.findByTokenHash({
      tenantId: input.context.tenantId,
      tokenHash
    })
  if (!found.ok) {
    return storeFailure(input.context, found.error)
  }
  if (found.value && (!isSessionRecord(found.value)
    || found.value.tenantId !== input.context.tenantId
    || (identified.value.kind === 'by-session'
      && found.value.sessionId !== identified.value.sessionId))) {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (found.value && !protectedValuesMatch(found.value.tokenHash, tokenHash)) {
    return identified.value.kind === 'by-session'
      ? ok(null)
      : authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!found.value || found.value.status !== 'active') {
    return ok(null)
  }
  const account = await config.store.durable.accounts.findById({
    tenantId: input.context.tenantId,
    accountId: found.value.accountId
  })
  if (!account.ok) {
    return storeFailure(input.context, account.error)
  }
  if (account.value && (!isAccountRecord(account.value)
    || account.value.tenantId !== input.context.tenantId
    || account.value.accountId !== found.value.accountId)) {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!account.value || account.value.status !== 'active') {
    return ok(null)
  }
  const resolvedAt = readNow(config)
  if (!resolvedAt) {
    return authErr(input.context, 'INTERNAL', 'INTERNAL')
  }
  if (found.value.expiresAt <= resolvedAt) {
    return ok(null)
  }
  return ok(toSessionView(found.value))
}

function protectedValuesMatch(left: ProtectedValue, right: ProtectedValue): boolean {
  try {
    return Boolean(
      left
      && right
      && left.type === 'protected-value'
      && right.type === 'protected-value'
      && left.scheme === right.scheme
      && left.keyId === right.keyId
      && typeof left.revealForPersistence === 'function'
      && typeof right.revealForPersistence === 'function'
      && left.revealForPersistence() === right.revealForPersistence()
    )
  } catch {
    return false
  }
}

export async function revokeSession(
  config: CreateAuthConfig,
  input: unknown
): Promise<Result<void, AuthFailure>> {
  if (!isRevokeSessionInput(input)) {
    return authErr(authContextFrom(input), 'VALIDATION_FAILED', 'INVALID_INPUT')
  }
  const now = readNow(config)
  if (!now) {
    return authErr(input.context, 'INTERNAL', 'INTERNAL')
  }
  const existing = await config.store.session.sessions.findById({
    tenantId: input.context.tenantId,
    sessionId: input.sessionId
  })
  if (!existing.ok) {
    return storeFailure(input.context, existing.error)
  }
  if (existing.value && (!isSessionRecord(existing.value)
    || existing.value.tenantId !== input.context.tenantId
    || existing.value.sessionId !== input.sessionId)) {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!existing.value || !actorMayRevokeSession(input.context, existing.value)) {
    return ok(undefined)
  }
  const allowed = await policy(config, {
    kind: 'revoke-session',
    context: input.context,
    sessionId: input.sessionId,
    session: toSessionView(existing.value)
  })
  if (!allowed.ok) {
    return allowed
  }
  const revokedAt = readNow(config)
  if (!revokedAt) {
    return authErr(input.context, 'INTERNAL', 'INTERNAL')
  }
  const revoked = await config.store.session.sessions.revoke({
    tenantId: input.context.tenantId,
    sessionId: input.sessionId,
    now: revokedAt
  })
  if (!revoked.ok) {
    return storeFailure(input.context, revoked.error)
  }
  if (revoked.value && (!isSessionRecord(revoked.value)
    || revoked.value.tenantId !== input.context.tenantId
    || revoked.value.sessionId !== input.sessionId
    || revoked.value.status !== 'revoked')) {
    return authErr(input.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  await emitEvent(config, input.context, {
    name: 'auth.session.revoked',
    sessionId: input.sessionId,
    outcome: 'success'
  }, revokedAt)
  return ok(undefined)
}

export async function createSession(
  config: CreateAuthConfig,
  context: AuthContext,
  accountId: AccountId,
  proof: AuthProof,
  request: CreateSessionRequest,
  now: Date,
  tx?: TransactionContext
): Promise<Result<CreatedSession, AuthFailure>> {
  if (!isValidDate(now)) {
    return authErr(context, 'INTERNAL', 'INTERNAL')
  }
  const ttl = resolveSessionTtl(config.session, request)
  if (!ttl.ok) {
    return authErr(context, ttl.error, 'INVALID_INPUT')
  }
  const expiresAt = new Date(now.getTime() + ttl.value * 1000)
  if (!isValidDate(expiresAt)) {
    return authErr(context, 'SESSION_TTL_INVALID', 'INVALID_INPUT')
  }
  const allowed = await policy(config, {
    kind: 'create-session',
    context,
    accountId,
    proof,
    requestedTtlSeconds: request.ttlSeconds,
    resolvedTtlSeconds: ttl.value,
    expiresAt
  })
  if (!allowed.ok) {
    return allowed
  }

  const sessionId = generateCoreId(config, 'session', context.tenantId, now)
  if (!sessionId) {
    return authErr(context, 'INTERNAL', 'INTERNAL')
  }
  let token: unknown
  try {
    token = await config.token.issue({
      tenantId: context.tenantId,
      accountId,
      sessionId,
      issuedAt: new Date(now.getTime()),
      expiresAt: new Date(expiresAt.getTime())
    })
  } catch {
    return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!isTokenIssueCallResult(token)) {
    return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!token.ok) {
    return authErr(context, token.error.reason, 'TEMPORARILY_UNAVAILABLE')
  }
  const rawToken = snapshotRawSecret(token.value.raw)
  const tokenHash = snapshotProtectedValue(token.value.tokenHash)
  if (!rawToken || !tokenHash) {
    return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }

  const sessionRecord: SessionRecord = {
    tenantId: context.tenantId,
    sessionId,
    accountId,
    tokenHash,
    status: 'active',
    issuedAt: now,
    expiresAt,
    createdAt: now,
    updatedAt: now
  }
  const expected = expectedSessionRecord(sessionRecord)
  const created = await config.store.session.sessions.create({
    record: {
      ...sessionRecord,
      issuedAt: new Date(sessionRecord.issuedAt.getTime()),
      expiresAt: new Date(sessionRecord.expiresAt.getTime()),
      createdAt: new Date(sessionRecord.createdAt.getTime()),
      updatedAt: new Date(sessionRecord.updatedAt.getTime())
    }
  }, tx)
  if (!created.ok) {
    return storeFailure(context, created.error)
  }
  if (!sessionRecordsMatch(created.value, expected)) {
    return authErr(context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  const completedAt = readNow(config)
  if (!completedAt) {
    return authErr(context, 'INTERNAL', 'INTERNAL')
  }
  if (created.value.expiresAt <= completedAt) {
    return authErr(context, 'SESSION_EXPIRED', 'SESSION_INVALID')
  }
  return ok({
    session: toSessionView(created.value),
    token: {
      raw: rawToken,
      issuedAt: new Date(now.getTime()),
      expiresAt: new Date(expiresAt.getTime())
    }
  })
}

function expectedSessionRecord(record: SessionRecord): {
  readonly tenantId: string
  readonly sessionId: string
  readonly accountId: string
  readonly status: SessionRecord['status']
  readonly tokenHash: { readonly scheme: string; readonly keyId: string; readonly verifier: string }
  readonly issuedAt: number
  readonly expiresAt: number
  readonly revokedAt?: number
  readonly createdAt: number
  readonly updatedAt: number
} {
  return {
    tenantId: record.tenantId,
    sessionId: record.sessionId,
    accountId: record.accountId,
    status: record.status,
    tokenHash: {
      scheme: record.tokenHash.scheme,
      keyId: record.tokenHash.keyId ?? '',
      verifier: record.tokenHash.revealForPersistence()
    },
    issuedAt: record.issuedAt.getTime(),
    expiresAt: record.expiresAt.getTime(),
    revokedAt: record.revokedAt?.getTime(),
    createdAt: record.createdAt.getTime(),
    updatedAt: record.updatedAt.getTime()
  }
}

function sessionRecordsMatch(value: unknown, expected: ReturnType<typeof expectedSessionRecord>): value is SessionRecord {
  return isSessionRecord(value)
    && value.tenantId === expected.tenantId
    && value.sessionId === expected.sessionId
    && value.accountId === expected.accountId
    && value.status === expected.status
    && value.tokenHash.scheme === expected.tokenHash.scheme
    && (value.tokenHash.keyId ?? '') === expected.tokenHash.keyId
    && value.tokenHash.revealForPersistence() === expected.tokenHash.verifier
    && value.issuedAt.getTime() === expected.issuedAt
    && value.expiresAt.getTime() === expected.expiresAt
    && value.revokedAt?.getTime() === expected.revokedAt
    && value.createdAt.getTime() === expected.createdAt
    && value.updatedAt.getTime() === expected.updatedAt
}

function resolveSessionTtl(
  sessionConfig: SessionConfig,
  request: CreateSessionRequest
): Result<number, 'SESSION_TTL_INVALID'> {
  const requested = request.ttlSeconds
  const ttl = requested ?? sessionConfig.defaultTtlSeconds
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    return { ok: false, error: 'SESSION_TTL_INVALID' }
  }
  if (sessionConfig.maxTtlSeconds !== undefined && ttl > sessionConfig.maxTtlSeconds) {
    return { ok: false, error: 'SESSION_TTL_INVALID' }
  }
  return ok(ttl)
}

function isGetSessionInput(input: unknown): input is GetSessionInput {
  if (!isRecord(input) || !isAuthContext(input.context)) return false
  return input.token === undefined || isRawSecret(input.token)
}

function isRevokeSessionInput(input: unknown): input is RevokeSessionInput {
  return isRecord(input) && isAuthContext(input.context) && isNonEmptyString(input.sessionId)
}

function actorMayRevokeSession(context: AuthContext, session: SessionRecord): boolean {
  return context.actor?.type === 'system'
    || (context.actor?.type === 'account' && context.actor.accountId === session.accountId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
