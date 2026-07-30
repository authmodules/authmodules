import type { MethodValidationContext, ValidatedMethodInput } from '@authmodules/contracts/method'
import type { MethodRef, PublicData } from '@authmodules/contracts/primitives'
import type { Result, ValidationFailure } from '@authmodules/contracts/result'
import type { RawSecretValue } from '@authmodules/contracts/security'
import type { PasswordValidatedInput } from './types.ts'
import { normalizeSubject } from '../subject/normalize.ts'
import { validationError } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'

const secretDescriptorTypes = new Set<unknown>(['raw-secret', 'protected-value', 'sealed-secret'])

export function validatePasswordInput(
  input: unknown,
  _context: MethodValidationContext,
  method: MethodRef,
  subjectKind: string,
  minPasswordLength: number,
  maxPasswordLength: number
): Result<ValidatedMethodInput<PasswordValidatedInput>, ValidationFailure> {
  if (!isRecord(input)) {
    return validationError('input')
  }

  const subjectInput = input.subject
  const password = input.password
  if (!isSafeText(subjectInput, subjectKind === 'email' ? 320 : 512) || subjectInput.trim() === '') {
    return validationError('subject')
  }
  if (!isRawStringSecret(password)) {
    return validationError('password')
  }
  let passwordValue
  try {
    passwordValue = password.reveal()
  } catch {
    return validationError('password')
  }
  if (typeof passwordValue !== 'string'
    || passwordValue.length < minPasswordLength
    || passwordValue.length > maxPasswordLength) return validationError('password')
  const passwordSnapshot = snapshotRawStringSecret(passwordValue)
  if (input.display !== undefined && !isSafeText(input.display, 512)) return validationError('display')
  if (!isPublicData(input.publicData)) return validationError('publicData')

  const subject = normalizeSubject(subjectInput, subjectKind)
  const lookup = {
    ...method,
    subject,
    subjectKind,
    display: input.display ?? subjectInput
  }

  return ok({
    value: {
      subject,
      password: passwordSnapshot,
      lookup,
      publicData: input.publicData
    },
    lookup,
    publicData: input.publicData
  })
}

function snapshotRawStringSecret(value: string): RawSecretValue<string> {
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
}

export function isStableMethodId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value)
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
}

function isPublicData(value: unknown): value is PublicData | undefined {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  const state: JsonTraversalState = { visiting: new Set<object>(), nodes: 0, characters: 0 }
  return Object.entries(value).every(([key, item]) => consumeText(key, 512, state)
    && key.length > 0
    && isJsonValue(item, 0, state))
}

function isJsonValue(value: unknown, depth: number, state: JsonTraversalState): boolean {
  state.nodes += 1
  if (state.nodes > 1000) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return consumeText(value, 65536, state)
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || value instanceof Date) return false
  if (isSecretDescriptor(value)) return false
  if (hasFunction(value, 'reveal')
    || hasFunction(value, 'revealForPersistence')
    || hasFunction(value, 'revealCiphertextForPersistence')) return false
  if (depth >= 16 || state.visiting.has(value)) return false
  state.visiting.add(value)
  const valid = Array.isArray(value)
    ? isDenseJsonArray(value) && value.every((item) => isJsonValue(item, depth + 1, state))
    : isPlainObject(value) && Object.entries(value).every(([key, item]) => consumeText(key, 512, state)
      && key.length > 0
      && isJsonValue(item, depth + 1, state))
  state.visiting.delete(value)
  return valid
}

function consumeText(value: unknown, maxLength: number, state: JsonTraversalState): value is string {
  if (!isSafeText(value, maxLength)) return false
  state.characters += value.length
  return state.characters <= 1_000_000
}

function isDenseJsonArray(value: unknown[]): boolean {
  const keys = Object.keys(value)
  return keys.length === value.length && keys.every((key, index) => key === String(index))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}

function isSecretDescriptor(value: object): boolean {
  return !Array.isArray(value) && 'type' in value && secretDescriptorTypes.has(value.type)
}

function isRawStringSecret(value: unknown): value is RawSecretValue<string> {
  return isRecord(value)
    && value.type === 'raw-secret'
    && typeof value.redacted === 'string'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
}

type JsonTraversalState = {
  readonly visiting: Set<object>
  nodes: number
  characters: number
}
