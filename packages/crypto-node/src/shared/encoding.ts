import type { RawSecretValue, SecretScalar } from '@authmodules/contracts/security'

export function revealSecret(value: SecretScalar | RawSecretValue<SecretScalar>): SecretScalar {
  if (isRawSecret(value)) {
    return value.reveal()
  }
  return value
}

function isRawSecret(value: SecretScalar | RawSecretValue<SecretScalar>): value is RawSecretValue<SecretScalar> {
  return typeof value === 'object'
    && !(value instanceof Uint8Array)
    && 'reveal' in value
    && typeof value.reveal === 'function'
}

export function toBuffer(value: SecretScalar): Buffer {
  if (value instanceof Uint8Array) {
    if (value.byteLength > 5_000_000) throw new TypeError('Crypto input is too large.')
    return Buffer.from(value)
  }
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 5_000_000) {
    throw new TypeError('Crypto input is invalid or too large.')
  }
  return Buffer.from(value)
}
