import { type MemoryAttemptGuard, type MemoryAttemptGuardOptions } from './types.ts'
import type {
  AuthGuard,
  GuardAfterAttemptInput,
  GuardBeforeAttemptInput
} from '@authmodules/contracts/guard'
import { assertOptions, isAttemptInput, isOutcome } from './validation.ts'
import { guardErr } from '../shared/result.ts'

const attemptsByGuard = new WeakMap<AuthGuard, Map<string, number[]>>()

export function createMemoryAttemptGuard(options?: MemoryAttemptGuardOptions): MemoryAttemptGuard

export function createMemoryAttemptGuard(options: MemoryAttemptGuardOptions = {}): MemoryAttemptGuard {
  const maxFailures = options.maxFailures ?? 5
  const windowMs = (options.windowSeconds ?? 60) * 1000
  const configuredRetryAfterSeconds = options.retryAfterSeconds
  const maxKeys = options.maxKeys ?? 10000
  const nowProvider = options.now ?? (() => new Date())
  assertOptions({ maxFailures, windowMs, configuredRetryAfterSeconds, maxKeys, nowProvider })
  const attempts = new Map<string, number[]>()
  let expirations: Expiration[] = []

  const guard: MemoryAttemptGuard = {
    async beforeAttempt(input?: GuardBeforeAttemptInput) {
      try {
        if (!isAttemptInput(input)) return guardErr('VALIDATION_FAILED')
      } catch {
        return guardErr('VALIDATION_FAILED')
      }
      try {
        const key = attemptKey(input)
        const now = nowMilliseconds(nowProvider)
        pruneExpired(attempts, expirations, now, windowMs)
        const recent = attempts.get(key) ?? []
        if (recent.length >= maxFailures) {
          const remainingSeconds = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000))
          return {
            ok: true,
            value: {
              allow: false,
              reason: 'RATE_LIMITED',
              publicCodeHint: 'RATE_LIMITED',
              retryAfterSeconds: configuredRetryAfterSeconds ?? remainingSeconds
            }
          }
        }
        return { ok: true, value: { allow: true } }
      } catch {
        return guardErr('INTERNAL')
      }
    },
    async afterAttempt(input?: GuardAfterAttemptInput) {
      try {
        if (!isAttemptInput(input) || !isOutcome(input.outcome)) return guardErr('VALIDATION_FAILED')
      } catch {
        return guardErr('VALIDATION_FAILED')
      }
      try {
        if (input.outcome.success) {
          attempts.delete(attemptKey(input))
          return { ok: true, value: undefined }
        }
        if (!input.outcome.countsAsAttempt) {
          return { ok: true, value: undefined }
        }
        const key = attemptKey(input)
        const now = nowMilliseconds(nowProvider)
        pruneExpired(attempts, expirations, now, windowMs)
        ensureCapacity(attempts, key, maxKeys)
        const recent = attempts.get(key) ?? []
        attempts.delete(key)
        const updated = [...recent, now].slice(-maxFailures)
        attempts.set(key, updated)
        heapPush(expirations, { key, expiresAt: updated[0] + windowMs })
        if (expirations.length > maxKeys * 4) {
          expirations = rebuildExpirations(attempts, windowMs)
        }
        return { ok: true, value: undefined }
      } catch {
        return guardErr('INTERNAL')
      }
    }
  }
  attemptsByGuard.set(guard, attempts)
  return guard
}

export function snapshotMemoryAttemptGuardAttemptsForTesting(
  guard: AuthGuard
): ReadonlyMap<string, readonly number[]> {
  const attempts = attemptsByGuard.get(guard)
  if (!attempts) throw new TypeError('Unknown memory attempt guard')
  return new Map([...attempts].map(([key, values]) => [key, [...values]]))
}

function nowMilliseconds(nowProvider: () => Date | number): number {
  const value = nowProvider()
  const milliseconds = value instanceof Date ? value.getTime() : value
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('now must return a valid Date or timestamp')
  }
  return milliseconds
}

function pruneExpired(
  attempts: Map<string, number[]>,
  expirations: Expiration[],
  now: number,
  windowMs: number
): void {
  while (expirations[0]?.expiresAt <= now) {
    const expired = heapPop(expirations)
    if (!expired) break
    const timestamps = attempts.get(expired.key)
    if (!timestamps || timestamps[0] + windowMs > now) continue
    const recent = timestamps.filter((timestamp: number): boolean => now - timestamp < windowMs)
    if (recent.length === 0) {
      attempts.delete(expired.key)
    } else {
      attempts.set(expired.key, recent)
      heapPush(expirations, { key: expired.key, expiresAt: recent[0] + windowMs })
    }
  }
}

function rebuildExpirations(attempts: Map<string, number[]>, windowMs: number): Expiration[] {
  const heap: Expiration[] = []
  for (const [key, timestamps] of attempts) {
    if (timestamps.length > 0) heapPush(heap, { key, expiresAt: timestamps[0] + windowMs })
  }
  return heap
}

function heapPush(heap: Expiration[], value: Expiration): void {
  heap.push(value)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (heap[parent].expiresAt <= value.expiresAt) break
    heap[index] = heap[parent]
    index = parent
  }
  heap[index] = value
}

function heapPop(heap: Expiration[]): Expiration | undefined {
  const first = heap[0]
  const last = heap.pop()
  if (!first || !last || heap.length === 0) return first
  let index = 0
  while (true) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    const child = right < heap.length && heap[right].expiresAt < heap[left].expiresAt ? right : left
    if (heap[child].expiresAt >= last.expiresAt) break
    heap[index] = heap[child]
    index = child
  }
  heap[index] = last
  return first
}

function ensureCapacity(attempts: Map<string, number[]>, key: string, maxKeys: number): void {
  if (attempts.has(key) || attempts.size < maxKeys) return
  const oldestKey = attempts.keys().next().value
  if (oldestKey !== undefined) attempts.delete(oldestKey)
}

function attemptKey(input: GuardBeforeAttemptInput): string {
  return JSON.stringify([
    input.context.tenantId,
    input.operation,
    input.challengeId,
    input.method.methodId,
    input.method.methodKind,
    input.lookup?.methodId,
    input.lookup?.methodKind,
    input.lookup?.subjectKind,
    input.lookup?.subject
  ])
}

type Expiration = {
  readonly key: string
  readonly expiresAt: number
}
