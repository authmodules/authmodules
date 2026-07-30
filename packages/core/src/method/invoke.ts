import type { MethodFailure, PublicAuthErrorCode } from '@authmodules/contracts/errors'
import type { MethodValidator, ValidatedMethodInput } from '@authmodules/contracts/method'
import type { MethodValidationContext, MethodExecutionContext } from '@authmodules/contracts/method'
import type { Result, ValidationFailure } from '@authmodules/contracts/result'
import { isPublicData } from '../validation/input.ts'
import { isValidatedMethodInput } from '../validation/method-data.ts'

const publicCodes = new Set<PublicAuthErrorCode>([
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
const invalidSnapshot = Symbol('invalid-method-value')

export function invokeMethodValidation(
  validator: MethodValidator<unknown>,
  input: unknown,
  context: MethodValidationContext
): Result<ValidatedMethodInput<unknown>, ValidationFailure> {
  try {
    const result = validator(input, context)
    const snapshot = isRecord(result) && result.ok === true
      ? snapshotValidatedMethodInput(result.value)
      : null
    if (snapshot) {
      return { ok: true, value: snapshot }
    }
  } catch {
    // Method validators are plugin boundaries; malformed implementations are validation failures.
  }
  return validationFailure()
}

function snapshotValidatedMethodInput(value: unknown): ValidatedMethodInput<unknown> | null {
  if (!isRecord(value)
    || !Object.hasOwn(value, 'value')
    || Object.keys(value).some((key) => !['lookup', 'publicData', 'value'].includes(key))) return null
  const methodValue = snapshotMethodValue(value.value, {
    visiting: new Set<object>(),
    nodes: 0,
    characters: 0
  }, 0)
  if (methodValue === invalidSnapshot) return null
  const lookupValue = value.lookup
  const publicDataValue = value.publicData
  const lookup = lookupValue === undefined
    ? undefined
    : snapshotLookup(lookupValue)
  if (lookupValue !== undefined && !lookup) return null
  const publicData = publicDataValue === undefined
    ? undefined
    : structuredClone(publicDataValue)
  const snapshot = {
    value: methodValue,
    ...(lookup === undefined ? {} : { lookup }),
    ...(publicData === undefined ? {} : { publicData })
  }
  return isValidatedMethodInput(snapshot) ? snapshot : null
}

function snapshotMethodValue(
  value: unknown,
  state: SnapshotState,
  depth: number
): unknown | typeof invalidSnapshot {
  state.nodes += 1
  if (state.nodes > 10_000 || depth > 32) return invalidSnapshot
  if (value === undefined || value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalidSnapshot
  if (typeof value === 'string') {
    state.characters += value.length
    return state.characters <= 1_000_000 ? value : invalidSnapshot
  }
  if (!value || typeof value !== 'object') return invalidSnapshot
  if (value instanceof Date) {
    const timestamp = Date.prototype.getTime.call(value)
    return Number.isFinite(timestamp) ? new Date(timestamp) : invalidSnapshot
  }
  if (value instanceof Uint8Array) {
    state.characters += value.byteLength
    return state.characters <= 1_000_000 ? new Uint8Array(value) : invalidSnapshot
  }
  if (state.visiting.has(value)) return invalidSnapshot
  const ownSnapshot = snapshotOwnDataProperties(value)
  if (!ownSnapshot) return invalidSnapshot
  const properties = ownSnapshot.values
  if (isSecretWrapper(properties)) return snapshotSecretWrapper(properties, state)

  state.visiting.add(value)
  if (Array.isArray(value)) {
    const length = ownSnapshot.arrayLength
    if (length === undefined) {
      state.visiting.delete(value)
      return invalidSnapshot
    }
    const keys = Object.keys(properties)
    if (keys.length !== length || !keys.every((key, index) => key === String(index))) {
      state.visiting.delete(value)
      return invalidSnapshot
    }
    const result: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const item = properties[String(index)]
      const snapshot = snapshotMethodValue(item, state, depth + 1)
      if (snapshot === invalidSnapshot) {
        state.visiting.delete(value)
        return invalidSnapshot
      }
      result.push(snapshot)
    }
    state.visiting.delete(value)
    return result
  }
  if (!isPlainObject(value)) {
    state.visiting.delete(value)
    return invalidSnapshot
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(properties)) {
    state.characters += key.length
    if (key.length === 0 || key.length > 512 || state.characters > 1_000_000) {
      state.visiting.delete(value)
      return invalidSnapshot
    }
    const snapshot = snapshotMethodValue(item, state, depth + 1)
    if (snapshot === invalidSnapshot) {
      state.visiting.delete(value)
      return invalidSnapshot
    }
    result[key] = snapshot
  }
  state.visiting.delete(value)
  return result
}

function snapshotSecretWrapper(
  value: Record<string, unknown>,
  state: SnapshotState
): unknown | typeof invalidSnapshot {
  try {
    const redacted = '[REDACTED]'
    if (value.type === 'raw-secret'
      && hasOnlyKeys(value, new Set(['redacted', 'reveal', 'toJSON', 'type']))
      && typeof value.reveal === 'function'
      && typeof value.toJSON === 'function') {
      const revealed = value.reveal()
      if (typeof revealed === 'string') {
        state.characters += revealed.length
        if (revealed.length === 0 || state.characters > 1_000_000) return invalidSnapshot
        return Object.freeze({
          type: 'raw-secret' as const,
          redacted,
          reveal: () => revealed,
          toJSON: () => redacted
        })
      }
      if (revealed instanceof Uint8Array) {
        state.characters += revealed.byteLength
        if (revealed.byteLength === 0 || state.characters > 1_000_000) return invalidSnapshot
        const captured = new Uint8Array(revealed)
        return Object.freeze({
          type: 'raw-secret' as const,
          redacted,
          reveal: () => new Uint8Array(captured),
          toJSON: () => redacted
        })
      }
      return invalidSnapshot
    }
    if (value.type === 'protected-value'
      && hasOnlyKeys(value, new Set([
        'createdAt',
        'keyId',
        'redacted',
        'revealForPersistence',
        'scheme',
        'toJSON',
        'type'
      ]))
      && isSafeText(value.scheme, 256)
      && (value.keyId === undefined || isSafeText(value.keyId, 512))
      && typeof value.revealForPersistence === 'function'
      && typeof value.toJSON === 'function') {
      const createdAt = snapshotOptionalDate(value.createdAt)
      if (value.createdAt !== undefined && !createdAt) return invalidSnapshot
      const verifier = value.revealForPersistence()
      if (typeof verifier !== 'string' || verifier.length === 0) return invalidSnapshot
      state.characters += verifier.length
      if (state.characters > 1_000_000) return invalidSnapshot
      return Object.freeze({
        type: 'protected-value' as const,
        scheme: value.scheme,
        redacted,
        keyId: value.keyId,
        createdAt,
        revealForPersistence: () => verifier,
        toJSON: () => redacted
      })
    }
    if (value.type === 'sealed-secret'
      && hasOnlyKeys(value, new Set([
        'algorithm',
        'expiresAt',
        'keyId',
        'redacted',
        'revealCiphertextForPersistence',
        'toJSON',
        'type'
      ]))
      && isSafeText(value.algorithm, 256)
      && isSafeText(value.keyId, 512)
      && typeof value.revealCiphertextForPersistence === 'function'
      && typeof value.toJSON === 'function') {
      const expiresAt = snapshotOptionalDate(value.expiresAt)
      if (value.expiresAt !== undefined && !expiresAt) return invalidSnapshot
      const ciphertext = value.revealCiphertextForPersistence()
      if (typeof ciphertext !== 'string' || ciphertext.length === 0) return invalidSnapshot
      state.characters += ciphertext.length
      if (state.characters > 1_000_000) return invalidSnapshot
      return Object.freeze({
        type: 'sealed-secret' as const,
        algorithm: value.algorithm,
        keyId: value.keyId,
        redacted,
        expiresAt,
        revealCiphertextForPersistence: () => ciphertext,
        toJSON: () => redacted
      })
    }
  } catch {
    return invalidSnapshot
  }
  return invalidSnapshot
}

function snapshotOptionalDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof Date)) return undefined
  const timestamp = Date.prototype.getTime.call(value)
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined
}

function isSecretWrapper(value: Record<string, unknown>): boolean {
  return (value.type === 'raw-secret' && typeof value.reveal === 'function')
    || (value.type === 'protected-value' && typeof value.revealForPersistence === 'function')
    || (value.type === 'sealed-secret' && typeof value.revealCiphertextForPersistence === 'function')
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function snapshotOwnDataProperties(value: object): OwnDataSnapshot | null {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const properties: Record<string, unknown> = {}
  let arrayLength: number | undefined
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') return null
    const descriptor = descriptors[key]
    if (Array.isArray(value) && key === 'length') {
      if (!descriptor
        || descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'number'
        || !Number.isSafeInteger(descriptor.value)
        || descriptor.value < 0) return null
      arrayLength = descriptor.value
      continue
    }
    if (!descriptor
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) return null
    properties[key] = descriptor.value
  }
  if (Array.isArray(value) && arrayLength === undefined) return null
  return { values: properties, arrayLength }
}

type OwnDataSnapshot = {
  readonly values: Record<string, unknown>
  readonly arrayLength?: number
}

type SnapshotState = {
  readonly visiting: Set<object>
  nodes: number
  characters: number
}

function snapshotLookup(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const methodId = value.methodId
  const methodKind = value.methodKind
  const subject = value.subject
  const subjectKind = value.subjectKind
  const display = value.display
  return {
    methodId,
    methodKind,
    subject,
    subjectKind,
    ...(display === undefined ? {} : { display })
  }
}

export async function invokeMethodRun<R extends object, C extends MethodExecutionContext>(
  runner: (input: unknown, context: C) => Promise<Result<R, MethodFailure>>,
  input: unknown,
  context: C
): Promise<Result<R, MethodFailure>> {
  try {
    const result = await runner(input, context)
    if (!isRecord(result)) return methodFailure()
    const outcome = result.ok
    if (outcome === true) {
      const snapshot = snapshotMethodValue(result.value, {
        visiting: new Set<object>(),
        nodes: 0,
        characters: 0
      }, 0)
      if (snapshot !== invalidSnapshot && isRecord(snapshot)) {
        return { ok: true, value: snapshot as R }
      }
    }
    if (outcome === false) {
      const snapshot = snapshotMethodValue(result.error, {
        visiting: new Set<object>(),
        nodes: 0,
        characters: 0
      }, 0)
      if (snapshot !== invalidSnapshot && isMethodFailure(snapshot)) {
        return { ok: false, error: snapshot }
      }
    }
  } catch {
    // Method runners are plugin boundaries; exceptions are converted to safe internal failures.
  }
  return methodFailure()
}

function isMethodFailure(value: unknown): value is MethodFailure {
  return isRecord(value)
    && value.type === 'component.failure'
    && value.component === 'method'
    && isSafeReason(value.reason)
    && (value.countsAsAttempt === undefined || typeof value.countsAsAttempt === 'boolean')
    && (value.safePublicCodeHint === undefined || publicCodes.has(value.safePublicCodeHint as PublicAuthErrorCode))
    && isPublicData(value.details)
}

function validationFailure(): Result<never, ValidationFailure> {
  return {
    ok: false,
    error: {
      type: 'validation.failure',
      issues: [{ code: 'METHOD_VALIDATION_FAILED' }]
    }
  }
}

function methodFailure(): Result<never, MethodFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'method',
      reason: 'INTERNAL'
    }
  }
}

function isSafeReason(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
