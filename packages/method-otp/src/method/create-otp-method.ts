import type {
  MethodBeginOperation,
  MethodBeginResult,
  MethodCompleteOperation,
  MethodCompleteResult,
  MethodExecutionContext,
  MethodValidationContext,
  NewChallengeContext,
  ExistingChallengeContext
} from '@authmodules/contracts/method'
import type { MethodRef } from '@authmodules/contracts/primitives'
import type { ProtectedValue } from '@authmodules/contracts/security'
import {
  type OtpBeginValidatedInput,
  type OtpCompleteValidatedInput,
  type OtpMethod,
  type OtpMethodOptions
} from './types.ts'
import { validateOtpBeginInput, validateOtpCompleteInput, validLookup } from './validation.ts'
import { normalizeOtpOptions } from './options.ts'
import { safeHmac, safeRandomSecretString, safeVerifyHmac, snapshotProtectedValue } from '../crypto/operations.ts'
import { safeResolveDeliveryTarget } from '../delivery/resolve.ts'
import { methodErr } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'

export function createOtpMethod(options: OtpMethodOptions): OtpMethod

export function createOtpMethod(options?: OtpMethodOptions): OtpMethod {
  const normalized = normalizeOtpOptions(options)
  const methodId = normalized.methodId ?? 'otp.email'
  const methodKind = 'otp'
  const subjectKind = normalized.subjectKind ?? 'email'
  const channel = normalized.channel ?? subjectKind
  const templateId = normalized.templateId ?? 'authmodules.otp'
  const ttlSeconds = normalized.ttlSeconds ?? 300
  const maxAttempts = normalized.maxAttempts ?? 5
  const alphabet = normalized.alphabet ?? '0123456789'
  const codeLength = normalized.codeLength ?? 6
  const crypto = normalized.crypto
  const verificationKey = normalized.verificationKey
  const resolveDeliveryTarget = normalized.resolveDeliveryTarget ?? ((input) => input.lookup.subject)

  const method: MethodRef = { methodId, methodKind }

  const operations = {
      begin: {
        validate(input: unknown, _context: MethodValidationContext) {
          return validateOtpBeginInput(input, method, subjectKind)
        },
        async run(
          input: OtpBeginValidatedInput,
          context: MethodExecutionContext & { readonly challenge: NewChallengeContext }
        ) {
          const hmacContext = otpHmacContext(context)
          if (!hmacContext) return methodErr('INTERNAL', false, 'CHALLENGE_FAILED')
          const code = safeRandomSecretString(crypto, { kind: 'alphabet', alphabet, length: codeLength })
          if (!code.ok) {
            return methodErr('CRYPTO_FAILED')
          }
          const codeHash = await safeHmac(crypto, {
            key: verificationKey,
            value: code.value,
            context: hmacContext,
            framing: 'hmac-sha256.v2',
            scheme: 'otp-hmac-sha256.v3'
          })
          if (!codeHash.ok) {
            return methodErr('CRYPTO_FAILED')
          }

          const expiresAt = new Date(context.now.getTime() + ttlSeconds * 1000)
          const target = await safeResolveDeliveryTarget(resolveDeliveryTarget, {
            lookup: input.lookup,
            context: context.auth
          })
          if (!target.ok) {
            return methodErr('DELIVERY_FAILED')
          }

          return ok<MethodBeginResult>({
            challengeMaterial: {
              schemaVersion: 'otp.v1',
              publicData: {
                subjectKind: input.lookup.subjectKind
              },
              privateData: {
                codeHash: codeHash.value
              }
            },
            expiresAt,
            maxAttempts,
            sideEffects: [
              {
                type: 'delivery',
                dispatchPolicy: 'required',
                idempotencyKey: context.challenge.challengeId,
                expiresAt,
                message: {
                  to: {
                    channel,
                    target: target.value,
                    display: input.lookup.display
                  },
                  templateId,
                  locale: input.locale,
                  data: {
                    code: code.value,
                    subject: input.lookup.subject
                  }
                }
              }
            ],
            publicData: input.publicData
          })
        }
      },
      complete: {
        validate(input: unknown, _context: MethodValidationContext) {
          return validateOtpCompleteInput(input, alphabet, codeLength)
        },
        async run(
          input: OtpCompleteValidatedInput,
          context: MethodExecutionContext & { readonly challenge: ExistingChallengeContext }
        ) {
          const challengeMaterial = context.challenge.challengeMaterial
          const codeHash = challengeMaterial.privateData?.codeHash
          const hmacContext = otpHmacContext(context)
          const hmacVerifier = protectedOtpHmac(codeHash)
          if (!hmacContext
            || challengeMaterial.schemaVersion !== 'otp.v1'
            || !hmacVerifier
            || !validLookup(context.lookup, method, subjectKind)) {
            return methodErr('INTERNAL', false, 'CHALLENGE_FAILED')
          }
          const verification = await safeVerifyHmac(crypto, hmacVerifier.scheme === 'otp-hmac-sha256.v2' ? {
            key: verificationKey,
            value: input.code,
            context: hmacContext,
            framing: 'hmac-sha256.legacy.v1',
            scheme: hmacVerifier.scheme,
            protectedValue: hmacVerifier.value,
            upgradeScheme: 'otp-hmac-sha256.v3'
          } : {
            key: verificationKey,
            value: input.code,
            context: hmacContext,
            framing: 'hmac-sha256.v2',
            scheme: hmacVerifier.scheme,
            protectedValue: hmacVerifier.value
          })
          if (!verification.ok) {
            return methodErr('CRYPTO_FAILED')
          }
          if (!verification.value.verified) {
            return methodErr('OTP_MISMATCH', true, 'CHALLENGE_FAILED')
          }

          const identity = {
            ...context.lookup,
            verifiedAt: context.now
          }

          return ok<MethodCompleteResult>({
            proof: {
              type: 'auth.proof',
              proofMethod: method,
              primaryIdentity: identity,
              evidence: [
                {
                  kind: 'otp',
                  method
                }
              ],
              assurance: {
                level: 'medium',
                factors: ['otp']
              },
              authTime: context.now
            },
            publicData: input.publicData
          })
        }
      }
    } satisfies {
      readonly begin: MethodBeginOperation<OtpBeginValidatedInput>
      readonly complete: MethodCompleteOperation<OtpCompleteValidatedInput>
    }

  return { methodId, methodKind, operations }
}

function otpHmacContext(context: unknown): string | undefined {
  if (!isRecord(context) || !isRecord(context.auth) || !isRecord(context.challenge)) return undefined
  const tenantId = context.auth.tenantId
  const challengeId = context.challenge.challengeId
  if (typeof tenantId !== 'string' || tenantId.length === 0 || typeof challengeId !== 'string' || challengeId.length === 0) {
    return undefined
  }
  return JSON.stringify(['authmodules.otp.challenge.v1', tenantId, challengeId])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protectedOtpHmac(value: unknown): {
  readonly scheme: 'otp-hmac-sha256.v2' | 'otp-hmac-sha256.v3'
  readonly value: ProtectedValue
} | undefined {
  const current = snapshotProtectedValue(value, 'otp-hmac-sha256.v3')
  if (current) return { scheme: 'otp-hmac-sha256.v3', value: current }
  const legacy = snapshotProtectedValue(value, 'otp-hmac-sha256.v2')
  if (legacy) return { scheme: 'otp-hmac-sha256.v2', value: legacy }
  return undefined
}
