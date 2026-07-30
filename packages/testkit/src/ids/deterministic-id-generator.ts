import type { IdGenerator } from '@authmodules/contracts/primitives'

export function deterministicIdGenerator(prefix?: string): IdGenerator

export function deterministicIdGenerator(prefix = 'test'): IdGenerator {
  const counters = new Map<string, number>()

  return {
    generate(input): string {
      const kind = String(input.kind)
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${prefix}_${kind}_${String(next).padStart(4, '0')}`
    }
  }
}
