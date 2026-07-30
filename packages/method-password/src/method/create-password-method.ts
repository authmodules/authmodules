import type {
  MethodAuthenticateOperation,
  MethodAuthenticateResult,
  MethodEnrollOperation,
  MethodExecutionContext,
  MethodValidationContext
} from '@authmodules/contracts/method'
import type { MethodRef } from '@authmodules/contracts/primitives'
import {
  type PasswordMethod,
  type PasswordMethodOptions,
  type PasswordValidatedInput
} from './types.ts'
import { isStableMethodId, validatePasswordInput } from './validation.ts'
import { makeIdentityClaim } from '../subject/normalize.ts'
import { makeProof } from '../proof/create.ts'
import { isProtectedValue, safeHashPassword, safeVerifyPassword } from '../password/operations.ts'
import { methodErr } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'

export function createPasswordMethod(options: PasswordMethodOptions): PasswordMethod

export function createPasswordMethod(options?: PasswordMethodOptions): PasswordMethod {
  const config: Partial<PasswordMethodOptions> = options ?? {}
  const methodId = config.methodId ?? 'password.email'
  const methodKind = 'password'
  const subjectKind = config.subjectKind ?? 'email'
  const minPasswordLength = config.minPasswordLength ?? 8
  const maxPasswordLength = config.maxPasswordLength ?? 1024
  const passwordHasher = config.passwordHasher
  if (!isStableMethodId(methodId)) throw new TypeError('Password methodId must be a stable dot-namespaced identifier')
  if (typeof subjectKind !== 'string'
    || subjectKind.length === 0
    || subjectKind.length > 128
    || /[\u0000-\u001f\u007f]/.test(subjectKind)) {
    throw new TypeError('Password subjectKind must be a non-empty safe string no longer than 128 characters')
  }
  if (!Number.isSafeInteger(minPasswordLength) || minPasswordLength < 8 || minPasswordLength > 128
    || !Number.isSafeInteger(maxPasswordLength) || maxPasswordLength < minPasswordLength || maxPasswordLength > 4096) {
    throw new TypeError('Password length limits are invalid')
  }
  if (!passwordHasher
    || typeof passwordHasher.hashPassword !== 'function'
    || typeof passwordHasher.verifyPassword !== 'function') {
    throw new TypeError('Password hasher is required')
  }

  const method: MethodRef = { methodId, methodKind }

  const enroll: MethodEnrollOperation<PasswordValidatedInput> = {
    validate(input: unknown, context: MethodValidationContext) {
      return validatePasswordInput(input, context, method, subjectKind, minPasswordLength, maxPasswordLength)
    },
    async run(input: PasswordValidatedInput, context: MethodExecutionContext) {
      const hash = await safeHashPassword(passwordHasher, {
        password: input.password,
        now: context.now
      })
      if (!hash.ok) {
        return methodErr('CRYPTO_FAILED')
      }

      const identity = makeIdentityClaim(context.lookup ?? input.lookup)
      return ok({
        identity,
        credentialMaterial: {
          schemaVersion: 'password.v1',
          privateData: {
            passwordHash: hash.value
          }
        },
        proof: makeProof(method, identity, context.now),
        publicData: input.publicData
      })
    }
  }

  const authenticate: MethodAuthenticateOperation<PasswordValidatedInput> = {
    validate(input: unknown, context: MethodValidationContext) {
      return validatePasswordInput(input, context, method, subjectKind, minPasswordLength, maxPasswordLength)
    },
    async run(input: PasswordValidatedInput, context: MethodExecutionContext) {
      const credentialMaterial = context.identity?.credentialMaterial
      const passwordHash = credentialMaterial?.privateData?.passwordHash
      if (credentialMaterial?.schemaVersion !== 'password.v1' || !isProtectedValue(passwordHash)) {
        const dummyWork = await safeHashPassword(passwordHasher, {
          password: input.password,
          now: context.now
        })
        if (!dummyWork.ok) return methodErr('CRYPTO_FAILED')
        return methodErr('CREDENTIAL_NOT_FOUND', true)
      }

      const verification = await safeVerifyPassword(passwordHasher, {
        password: input.password,
        protectedPassword: passwordHash,
        now: context.now
      })
      if (!verification.ok) {
        return methodErr('CRYPTO_FAILED')
      }
      if (!verification.value.verified) {
        return methodErr('PASSWORD_MISMATCH', true, 'AUTHENTICATION_FAILED')
      }

      const lookup = context.lookup ?? input.lookup
      const proof = makeProof(method, makeIdentityClaim(lookup), context.now)
      const result: MethodAuthenticateResult = {
        proof,
        publicData: input.publicData
      }
      if (verification.value.needsRehash === true && context.identity?.credentialMaterial) {
        return ok({
          ...result,
          credentialMaterial: {
            ...context.identity.credentialMaterial,
            privateData: {
              ...context.identity.credentialMaterial.privateData,
              passwordHash: verification.value.upgradedValue
            }
          }
        })
      }
      return ok(result)
    }
  }

  return {
    methodId,
    methodKind,
    operations: {
      enroll,
      authenticate
    }
  }
}
