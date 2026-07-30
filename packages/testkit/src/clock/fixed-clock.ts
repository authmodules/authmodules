import type { Clock } from '@authmodules/contracts/primitives'

export type FixedClock = Clock & {
  set(next: Date | string | number): void
  advance(milliseconds: number): Date
}

export function fixedClock(initial?: Date | string | number): FixedClock

export function fixedClock(initial: Date | string | number = new Date(0)): FixedClock {
  let current = new Date(initial)

  return {
    now(): Date {
      return new Date(current)
    },
    set(next: Date | string | number): void {
      current = new Date(next)
    },
    advance(milliseconds: number): Date {
      current = new Date(current.getTime() + milliseconds)
      return new Date(current)
    }
  }
}
