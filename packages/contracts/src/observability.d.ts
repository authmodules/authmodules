import type { Result } from './result.js'
import type { AccountId, ChallengeId, ExtensionString, MethodId, PublicData, RequestId, SessionId, TenantId } from './primitives.js'
import type { EventSinkFailure } from './errors.js'

export type StableAuthEventName =
  | 'auth.enroll.started'
  | 'auth.enroll.succeeded'
  | 'auth.enroll.failed'
  | 'auth.authenticate.started'
  | 'auth.authenticate.succeeded'
  | 'auth.authenticate.failed'
  | 'auth.challenge.started'
  | 'auth.challenge.completed'
  | 'auth.challenge.failed'
  | 'auth.session.created'
  | 'auth.session.revoked'
  | 'auth.side_effect.dispatched'
  | 'auth.side_effect.failed'

export type AuthEventName = StableAuthEventName | ExtensionString

export type AuthEvent = {
  readonly name: AuthEventName
  readonly tenantId: TenantId
  readonly requestId?: RequestId
  readonly accountId?: AccountId
  readonly sessionId?: SessionId
  readonly methodId?: MethodId
  readonly challengeId?: ChallengeId
  readonly occurredAt: Date
  readonly outcome?: 'success' | 'failure'
  readonly attributes?: PublicData
}

/** Baseline event sinks are best-effort observability only. Required audit must be modeled as a durable side effect or outbox record. */
export interface AuthEventSink {
  emit(event: AuthEvent): Promise<Result<void, EventSinkFailure>>
}
