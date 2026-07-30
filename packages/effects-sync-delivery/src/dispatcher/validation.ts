import type { SideEffectDispatchInput } from '@authmodules/contracts/effects'

export function isDispatchInput(input?: SideEffectDispatchInput): input is SideEffectDispatchInput {
  return Boolean(
    input &&
    typeof input === 'object' &&
    input.now instanceof Date &&
    !Number.isNaN(input.now.getTime()) &&
    Array.isArray(input.effects) &&
    input.effects.length <= 1000
  )
}

export function snapshotDispatchInput(input: unknown): SideEffectDispatchInput | undefined {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
    const source = input as Record<string, unknown>
    const context = source.context
    const effectsSource = source.effects
    const nowSource = source.now
    if (!Array.isArray(effectsSource) || effectsSource.length > 1000) return undefined
    const snapshot = {
      context,
      effects: effectsSource.slice(),
      now: nowSource instanceof Date ? new Date(nowSource.getTime()) : nowSource
    }
    return isDispatchInput(snapshot as SideEffectDispatchInput)
      ? snapshot as SideEffectDispatchInput
      : undefined
  } catch {
    return undefined
  }
}
