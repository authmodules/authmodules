import type { ValidatedMethodInput } from '@authmodules/contracts/method'
import type { IdentityLookup, MethodRef, PublicData } from '@authmodules/contracts/primitives'
import type { Result, ValidationFailure } from '@authmodules/contracts/result'
import type { RawSecretValue } from '@authmodules/contracts/security'
import type { OtpBeginValidatedInput, OtpCompleteValidatedInput } from './types.ts'
import { isSafeText } from './options.ts'
import { normalizeOtpSubject } from '../subject/normalize.ts'
import { validationError } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'

const secretDescriptorTypes = new Set<unknown>(['raw-secret', 'protected-value', 'sealed-secret'])

export function validateOtpCompleteInput(
  input: unknown,
  alphabet: string,
  codeLength: number
): Result<ValidatedMethodInput<OtpCompleteValidatedInput>, ValidationFailure> {
  if (!isRecord(input)) {
    return validationError('input')
  }
  if (!isRawStringSecret(input.code)) {
    return validationError('code')
  }
  let code: string
  try {
    code = input.code.reveal()
  } catch {
    return validationError('code')
  }
  if (code.length !== codeLength || [...code].some((character) => !alphabet.includes(character))) {
    return validationError('code')
  }
  if (!isPublicData(input.publicData)) return validationError('publicData')

  return ok({
    value: {
      code: input.code,
      publicData: input.publicData
    },
    publicData: input.publicData
  })
}

export function validateOtpBeginInput(
  input: unknown,
  method: MethodRef,
  subjectKind: string
): Result<ValidatedMethodInput<OtpBeginValidatedInput>, ValidationFailure> {
  if (!isRecord(input)) return validationError('input')

  if (!isSafeText(input.subject, subjectKind === 'email' ? 320 : 512) || input.subject.trim() === '') {
    return validationError('subject')
  }
  if (input.display !== undefined && !isSafeText(input.display, 512)) return validationError('display')
  if (input.locale !== undefined && (!isSafeText(input.locale, 128) || input.locale.length === 0)) return validationError('locale')
  if (!isPublicData(input.publicData)) return validationError('publicData')

  const subject = normalizeOtpSubject(input.subject, subjectKind)
  const lookup = {
    ...method,
    subject,
    subjectKind,
    display: input.display ?? input.subject
  }

  return ok({
    value: {
      subject,
      locale: typeof input.locale === 'string' ? input.locale : undefined,
      publicData: input.publicData,
      lookup
    },
    lookup,
    publicData: input.publicData
  })
}

export function validLookup(
  lookup: unknown,
  method: MethodRef,
  subjectKind: string
): lookup is IdentityLookup {
  return isRecord(lookup)
    && lookup.methodId === method.methodId
    && lookup.methodKind === method.methodKind
    && lookup.subjectKind === subjectKind
    && typeof lookup.subject === 'string'
    && lookup.subject.length > 0
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

function isRawStringSecret(value: unknown): value is RawSecretValue<string> {
  return isRecord(value)
    && value.type === 'raw-secret'
    && typeof value.redacted === 'string'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
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

type JsonTraversalState = {
  readonly visiting: Set<object>
  nodes: number
  characters: number
}
