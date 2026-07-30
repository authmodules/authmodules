export function requireHarness<T>(value: T | undefined, name: string): T {
  if (!value) throw new TypeError(`Compliance harness requires ${name}`)
  return value
}

export function complianceAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
