import type { CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthFailure } from '@authmodules/contracts/errors'
import type {
  SideEffectDispatchFailure,
  SideEffectDispatchItem,
  SideEffectDispatchResult,
  SideEffectRequest
} from '@authmodules/contracts/effects'
import type { AuthContext, DispatchContext } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'
import type { TransactionContext } from '@authmodules/contracts/transaction'
import type { SessionView } from '@authmodules/contracts/views'
import type { IssuedTokenView } from '@authmodules/contracts/token'
import { emitEvent } from '../events/emit.ts'
import { snapshotSideEffect } from '../method/snapshot.ts'
import { authErr } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'
import { isPublicData } from '../validation/input.ts'

const dispatchFailureKeys = new Set(['details', 'index', 'reason', 'type'])
const dispatchItemKeys = new Set(['index', 'type'])
const dispatchResultKeys = new Set(['deferred', 'dispatched', 'failed'])
const effectsFailureKeys = new Set(['component', 'details', 'reason', 'type'])

export type PersistedOperationEffects = {
  readonly session?: { readonly session: SessionView; readonly token: IssuedTokenView }
  readonly effects?: SideEffectDispatchResult
}

export function mergeSideEffectResults(
  first: SideEffectDispatchResult | undefined,
  second: SideEffectDispatchResult | undefined
): SideEffectDispatchResult | undefined {
  if (!first) return second
  if (!second) return first
  const deferred = [...(first.deferred ?? []), ...(second.deferred ?? [])]
  const failed = [...(first.failed ?? []), ...(second.failed ?? [])]
  return {
    dispatched: [...first.dispatched, ...second.dispatched],
    deferred: deferred.length > 0 ? deferred : undefined,
    failed: failed.length > 0 ? failed : undefined
  }
}

export function dispatchRequiredSideEffects(
  config: CreateAuthConfig,
  context: AuthContext,
  sideEffects: readonly SideEffectRequest[] | undefined,
  now: Date,
  tx?: TransactionContext
): Promise<Result<SideEffectDispatchResult | undefined, AuthFailure>> {
  return dispatchSelectedSideEffects(config, context, sideEffects, 'required', now, tx)
}

export function dispatchBestEffortSideEffects(
  config: CreateAuthConfig,
  context: AuthContext,
  sideEffects: readonly SideEffectRequest[] | undefined,
  now: Date
): Promise<Result<SideEffectDispatchResult | undefined, AuthFailure>> {
  return dispatchSelectedSideEffects(config, context, sideEffects, 'best-effort', now)
}

export async function dispatchSideEffects(
  config: CreateAuthConfig,
  context: AuthContext,
  sideEffects: readonly SideEffectRequest[] | undefined,
  now: Date,
  tx?: TransactionContext
): Promise<Result<SideEffectDispatchResult | undefined, AuthFailure>> {
  if (!sideEffects || sideEffects.length === 0) {
    return ok(undefined)
  }
  const hasRequired = sideEffects.some((effect) => effect.dispatchPolicy === 'required')
  if (!config.effects) {
    return dispatchFailure(config, context, hasRequired, 'SIDE_EFFECT_FAILED', now)
  }
  const expectedEffects = sideEffects.map(snapshotSideEffect)
  try {
    const result = await config.effects.dispatch({
      context: toDispatchContext(context),
      effects: expectedEffects.map(snapshotSideEffect),
      now: new Date(now.getTime()),
      tx
    })
    if (result?.ok === true && isDispatchResult(result.value, expectedEffects)) {
      return ok(result.value)
    }
    if (result?.ok === false && isEffectsFailure(result.error)) {
      return dispatchFailure(config, context, hasRequired, result.error.reason, now)
    }
  } catch {
    // Collaborator failures are mapped below without leaking provider details.
  }
  return dispatchFailure(config, context, hasRequired, 'SIDE_EFFECT_FAILED', now)
}

async function dispatchSelectedSideEffects(
  config: CreateAuthConfig,
  context: AuthContext,
  sideEffects: readonly SideEffectRequest[] | undefined,
  policy: SideEffectRequest['dispatchPolicy'],
  now: Date,
  tx?: TransactionContext
): Promise<Result<SideEffectDispatchResult | undefined, AuthFailure>> {
  const selected = (sideEffects ?? [])
    .map((effect, index) => ({ effect, index }))
    .filter(({ effect }) => effect.dispatchPolicy === policy)
  if (selected.length === 0) return ok(undefined)
  const result = await dispatchSideEffects(
    config,
    context,
    selected.map(({ effect }) => effect),
    now,
    tx
  )
  if (!result.ok || !result.value) return result
  const originalIndexes = selected.map(({ index }) => index)
  return ok({
    dispatched: remapItems(result.value.dispatched, originalIndexes),
    deferred: result.value.deferred
      ? remapItems(result.value.deferred, originalIndexes)
      : undefined,
    failed: result.value.failed
      ? result.value.failed.map((item) => ({ ...item, index: originalIndexes[item.index] as number }))
      : undefined
  })
}

function remapItems(
  items: readonly SideEffectDispatchItem[],
  originalIndexes: readonly number[]
): SideEffectDispatchItem[] {
  return items.map((item) => ({ ...item, index: originalIndexes[item.index] as number }))
}

export async function emitPersistedEvents(
  config: CreateAuthConfig,
  context: AuthContext,
  persisted: PersistedOperationEffects,
  now: Date
): Promise<void> {
  if (persisted?.session?.session) {
    await emitEvent(config, context, {
      name: 'auth.session.created',
      accountId: persisted.session.session.accountId,
      sessionId: persisted.session.session.sessionId,
      outcome: 'success'
    }, now)
  }
  await emitSideEffectEvents(config, context, persisted?.effects, now)
}

async function emitSideEffectEvents(
  config: CreateAuthConfig,
  context: AuthContext,
  effects: SideEffectDispatchResult | undefined,
  now: Date
): Promise<void> {
  if (!effects) return
  for (const item of effects.dispatched ?? []) {
    await emitEvent(config, context, {
      name: 'auth.side_effect.dispatched',
      outcome: 'success',
      attributes: { index: item.index, type: item.type }
    }, now)
  }
  for (const item of effects.deferred ?? []) {
    await emitEvent(config, context, {
      name: 'auth.side_effect.dispatched',
      outcome: 'success',
      attributes: { index: item.index, type: item.type, deferred: true }
    }, now)
  }
  for (const item of effects.failed ?? []) {
    await emitEvent(config, context, {
      name: 'auth.side_effect.failed',
      outcome: 'failure',
      attributes: { index: item.index, type: item.type, reason: item.reason }
    }, now)
  }
}

function toDispatchContext(context: AuthContext): DispatchContext {
  return {
    tenantId: context.tenantId,
    requestId: context.requestId,
    locale: context.locale,
    metadata: context.metadata ? structuredClone(context.metadata) : undefined
  }
}

async function dispatchFailure(
  config: CreateAuthConfig,
  context: AuthContext,
  required: boolean,
  reason: string,
  now: Date
): Promise<Result<SideEffectDispatchResult | undefined, AuthFailure>> {
  await emitEvent(config, context, {
    name: 'auth.side_effect.failed',
    outcome: 'failure',
    attributes: { reason }
  }, now)
  return required ? authErr(context, reason, 'TEMPORARILY_UNAVAILABLE') : ok(undefined)
}

function isDispatchResult(value: unknown, effects: readonly SideEffectRequest[]): value is SideEffectDispatchResult {
  if (!isRecord(value)
    || !hasOnlyKeys(value, dispatchResultKeys)
    || !Array.isArray(value.dispatched)
    || (value.deferred !== undefined && !Array.isArray(value.deferred))
    || (value.failed !== undefined && !Array.isArray(value.failed))) return false
  const dispatched: readonly unknown[] = value.dispatched
  const deferred: readonly unknown[] = value.deferred ?? []
  const failed: readonly unknown[] = value.failed ?? []
  if (!dispatched.every(isDispatchItem)
    || !deferred.every(isDispatchItem)
    || !failed.every(isDispatchFailure)) return false
  const items = [...dispatched, ...deferred, ...failed]
  const indexes = new Set<number>()
  for (const item of items) {
    if (!Number.isSafeInteger(item.index)
      || item.index < 0
      || item.index >= effects.length
      || indexes.has(item.index)) return false
    indexes.add(item.index)
  }
  return indexes.size === effects.length
    && failed.every((item) => effects[item.index]?.dispatchPolicy === 'best-effort')
}

function isDispatchItem(value: unknown): value is SideEffectDispatchItem {
  return isRecord(value)
    && hasOnlyKeys(value, dispatchItemKeys)
    && typeof value.index === 'number'
    && Number.isSafeInteger(value.index)
    && value.type === 'delivery'
}

function isDispatchFailure(value: unknown): value is SideEffectDispatchFailure {
  return isRecord(value)
    && hasOnlyKeys(value, dispatchFailureKeys)
    && typeof value.index === 'number'
    && Number.isSafeInteger(value.index)
    && value.type === 'delivery'
    && isSafeReason(value.reason)
    && (value.details === undefined || isPublicData(value.details))
}

function isEffectsFailure(value: unknown): value is {
  readonly type: 'component.failure'
  readonly component: 'effects'
  readonly reason: string
} {
  return isRecord(value)
    && hasOnlyKeys(value, effectsFailureKeys)
    && value.type === 'component.failure'
    && value.component === 'effects'
    && isSafeReason(value.reason)
    && (value.details === undefined || isPublicData(value.details))
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
