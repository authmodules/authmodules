import type { RawSecretValue } from '@authmodules/contracts/security'

export function rawSecret(value: string, redacted = '[REDACTED]'): RawSecretValue<string> {
  return {
    type: 'raw-secret',
    redacted,
    reveal(): string {
      return value
    },
    toJSON(): string {
      return redacted
    }
  }
}
