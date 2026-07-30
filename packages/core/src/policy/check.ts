import type { CreateAuthConfig, PolicyCheck, PolicyDecision } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import { authErr } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'
import { decisionAuthContext } from '../shared/context.ts'

const allowKeys = new Set(['allow'])
const denyKeys = new Set(['allow', 'publicCodeHint', 'reason'])
const policyReasons = new Set([
  'ACCOUNT_LINKING_DENIED',
  'ACCOUNT_RESOLUTION_DENIED',
  'METHOD_DISABLED',
  'POLICY_DENIED',
  'SESSION_CREATION_DENIED',
  'TENANT_DISABLED'
])
const publicCodes = new Set([
  'ACCOUNT_UNAVAILABLE',
  'AUTHENTICATION_FAILED',
  'AUTHORIZATION_FAILED',
  'CHALLENGE_FAILED',
  'CONFLICT',
  'INTERNAL',
  'INVALID_INPUT',
  'RATE_LIMITED',
  'SESSION_INVALID',
  'TEMPORARILY_UNAVAILABLE'
])

export async function policy(config: CreateAuthConfig, check: PolicyCheck): Promise<Result<void, AuthFailure>> {
  if (!config.policy) {
    return ok(undefined)
  }
  let decision: unknown
  try {
    decision = await config.policy({
      ...structuredClone(check),
      context: decisionAuthContext(check.context)
    })
  } catch {
    return authErr(check.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (!isPolicyDecision(decision)) {
    return authErr(check.context, 'INTERNAL', 'TEMPORARILY_UNAVAILABLE')
  }
  if (decision.allow) {
    return ok(undefined)
  }
  return authErr(check.context, decision.reason, decision.publicCodeHint ?? 'AUTHORIZATION_FAILED')
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  if (!isRecord(value)) return false
  if (value.allow === true) return hasOnlyKeys(value, allowKeys)
  return value.allow === false
    && hasOnlyKeys(value, denyKeys)
    && typeof value.reason === 'string'
    && policyReasons.has(value.reason)
    && (value.publicCodeHint === undefined
      || (typeof value.publicCodeHint === 'string' && publicCodes.has(value.publicCodeHint)))
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
