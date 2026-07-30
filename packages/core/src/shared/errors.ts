import type {
  AuthFailure,
  InternalAuthReason,
  PublicAuthErrorCode,
  StoreFailure
} from '@authmodules/contracts/errors'
import type { AuthContext } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import { isPublicData } from '../validation/input.ts'

export function storeFailure(context: AuthContext | undefined, failure: StoreFailure): Result<never, AuthFailure> {
  const reason = isStoreFailure(failure)
    ? normalizeInternalReason(failure.reason, 'STORE_UNAVAILABLE')
    : 'STORE_UNAVAILABLE'
  return authErr(context, reason, mapReason(reason))
}

export function authErr(
  context: AuthContext | undefined,
  internalReason: InternalAuthReason,
  publicCode?: PublicAuthErrorCode,
  retryAfterSeconds?: number
): Result<never, AuthFailure> {
  const reason = normalizeInternalReason(internalReason, 'INTERNAL')
  return {
    ok: false,
    error: {
      type: 'auth.failure',
      internalReason: reason,
      publicError: {
        code: publicCode ?? mapReason(reason),
        message: 'Authentication request failed.',
        requestId: context?.requestId,
        retryAfterSeconds
      }
    }
  }
}

export function mapReason(reason: unknown): PublicAuthErrorCode {
  switch (reason) {
    case 'VALIDATION_FAILED':
    case 'SESSION_TTL_INVALID':
      return 'INVALID_INPUT'
    case 'IDENTITY_CONFLICT':
    case 'CREDENTIAL_CONFLICT':
      return 'CONFLICT'
    case 'ACCOUNT_DISABLED':
    case 'ACCOUNT_DELETED':
    case 'ACCOUNT_UNAVAILABLE':
      return 'ACCOUNT_UNAVAILABLE'
    case 'CHALLENGE_NOT_FOUND':
    case 'CHALLENGE_EXPIRED':
    case 'CHALLENGE_ALREADY_CONSUMED':
    case 'CHALLENGE_ATTEMPTS_EXCEEDED':
    case 'OTP_MISMATCH':
      return 'CHALLENGE_FAILED'
    case 'SESSION_NOT_FOUND':
    case 'SESSION_EXPIRED':
    case 'SESSION_REVOKED':
    case 'TOKEN_INVALID':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_TENANT_MISMATCH':
    case 'TOKEN_HASH_NOT_FOUND':
      return 'SESSION_INVALID'
    case 'RATE_LIMITED':
    case 'LOCKED':
      return 'RATE_LIMITED'
    case 'POLICY_DENIED':
    case 'ACCOUNT_LINKING_DENIED':
      return 'AUTHORIZATION_FAILED'
    case 'STORE_UNAVAILABLE':
    case 'DELIVERY_FAILED':
    case 'SIDE_EFFECT_FAILED':
    case 'EVENT_SINK_FAILED':
      return 'TEMPORARILY_UNAVAILABLE'
    case 'PASSWORD_MISMATCH':
    case 'CREDENTIAL_NOT_FOUND':
    case 'IDENTITY_NOT_FOUND':
    case 'AUTHENTICATION_FAILED':
      return 'AUTHENTICATION_FAILED'
    default:
      return 'INTERNAL'
  }
}

export function normalizeInternalReason(
  value: unknown,
  fallback: InternalAuthReason
): InternalAuthReason {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : fallback
}

function isStoreFailure(value: unknown): value is StoreFailure {
  return isRecord(value)
    && Object.keys(value).every((key) => ['component', 'details', 'reason', 'type'].includes(key))
    && value.type === 'component.failure'
    && value.component === 'store'
    && normalizeInternalReason(value.reason, '') !== ''
    && (value.details === undefined || isPublicData(value.details))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function catchBoundary<T>(
  context: AuthContext | undefined,
  fn: () => Promise<Result<T, AuthFailure>>
): Promise<Result<T, AuthFailure>> {
  try {
    return await fn()
  } catch {
    return authErr(context, 'INTERNAL', 'INTERNAL')
  }
}
