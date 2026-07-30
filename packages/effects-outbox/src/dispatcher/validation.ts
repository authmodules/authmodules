import type { SideEffectDispatchInput } from '@authmodules/contracts/effects'
import type { TransactionScope } from '@authmodules/contracts/transaction'

export function isDispatchInput(input: unknown): input is SideEffectDispatchInput {
  return isRecord(input)
    && input.now instanceof Date &&
    !Number.isNaN(input.now.getTime()) &&
    Array.isArray(input.effects) &&
    input.effects.length <= 1000
    && (input.tx === undefined || isTransactionContext(input.tx))
}

export function snapshotDispatchInput(input: unknown): DispatchInputSnapshot | undefined {
  try {
    if (!isRecord(input)) return undefined
    const context = input.context
    const effectsSource = input.effects
    const nowSource = input.now
    const txSource = input.tx
    if (!Array.isArray(effectsSource) || effectsSource.length > 1000) return undefined
    const effects = effectsSource.slice()
    const now = nowSource instanceof Date ? new Date(nowSource.getTime()) : nowSource
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return undefined
    const transaction = txSource === undefined ? undefined : snapshotTransactionContext(txSource)
    if (txSource !== undefined && transaction === undefined) return undefined
    return {
      context,
      effects,
      now,
      ...(transaction === undefined ? {} : {
        tx: transaction.context,
        transactionScopes: transaction.covers
      })
    } as DispatchInputSnapshot
  } catch {
    return undefined
  }
}

function snapshotTransactionContext(value: unknown): {
  readonly context: NonNullable<SideEffectDispatchInput['tx']>
  readonly covers: readonly TransactionScope[]
} | undefined {
  if (!isRecord(value)) return undefined
  const transactionId = value.transactionId
  const coversSource = value.covers
  if (!Array.isArray(coversSource)) return undefined
  const snapshot = { transactionId, covers: coversSource.slice() }
  return isTransactionContext(snapshot)
    ? { context: value as NonNullable<SideEffectDispatchInput['tx']>, covers: snapshot.covers }
    : undefined
}

function isTransactionContext(value: unknown): value is NonNullable<SideEffectDispatchInput['tx']> {
  return isRecord(value)
    && typeof value.transactionId === 'string'
    && value.transactionId.length > 0
    && Array.isArray(value.covers)
    && value.covers.every((scope) => typeof scope === 'string' && scope.length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type DispatchInputSnapshot = SideEffectDispatchInput & {
  readonly transactionScopes?: readonly TransactionScope[]
}
