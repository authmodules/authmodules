import type { Auth, CreateAuthConfig } from '@authmodules/contracts/core'
import type { ConfigValidationFailure } from '@authmodules/contracts/errors'
import type { AuthContext } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import { enroll } from '../operations/enroll.ts'
import { authenticate } from '../operations/authenticate.ts'
import { begin, complete } from '../operations/challenge.ts'
import { getSession, revokeSession } from '../operations/session.ts'
import { validateConfig } from '../config/validation.ts'
import { catchBoundary } from '../shared/errors.ts'
import { isAuthContext } from '../validation/input.ts'

export function createAuth(config: CreateAuthConfig): Result<Auth, ConfigValidationFailure>

export function createAuth(config?: CreateAuthConfig): Result<Auth, ConfigValidationFailure> {
  const configFailure = validateConfig(config)
  if (configFailure) {
    return {
      ok: false,
      error: {
        type: 'component.failure',
        component: 'config',
        reason: 'CONFIG_INVALID',
        details: configFailure
      }
    }
  }
  const validConfig = config as CreateAuthConfig

  const auth: Auth = {
    enroll(input) {
      return catchBoundary(contextFrom(input), () => enroll(validConfig, isolateOperationInput(input)))
    },
    authenticate(input) {
      return catchBoundary(contextFrom(input), () => authenticate(validConfig, isolateOperationInput(input)))
    },
    begin(input) {
      return catchBoundary(contextFrom(input), () => begin(validConfig, isolateOperationInput(input)))
    },
    complete(input) {
      return catchBoundary(contextFrom(input), () => complete(validConfig, isolateOperationInput(input)))
    },
    getSession(input) {
      return catchBoundary(contextFrom(input), () => getSession(validConfig, isolateOperationInput(input)))
    },
    revokeSession(input) {
      return catchBoundary(contextFrom(input), () => revokeSession(validConfig, isolateOperationInput(input)))
    }
  }

  return { ok: true, value: auth }
}

function contextFrom(value: unknown): AuthContext | undefined {
  try {
    if (!isRecord(value) || !('context' in value)) return undefined
    return isAuthContext(value.context) ? structuredClone(value.context) : undefined
  } catch {
    return undefined
  }
}

function isolateOperationInput(value: unknown): unknown {
  if (!isRecord(value)) return value
  const isolated: Record<string, unknown> = { ...value }
  if (isAuthContext(value.context)) isolated.context = structuredClone(value.context)
  if (isRecord(value.account)) isolated.account = { ...value.account }
  if (isRecord(value.session)) isolated.session = { ...value.session }
  return isolated
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
