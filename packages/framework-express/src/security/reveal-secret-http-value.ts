import type {
  SecretHttpValue
} from '@authmodules/contracts/carrier'

export function revealSecretHttpValue(value: SecretHttpValue): string

export function revealSecretHttpValue(value: SecretHttpValue): string {
  const source = value.parts
  if (!Array.isArray(source)) throw new TypeError('Secret HTTP value is invalid')
  const parts = [...source]
  if (parts.length > 100) throw new TypeError('Secret HTTP value is invalid')
  const revealedParts: string[] = []
  let length = 0
  for (const part of parts) {
    const revealed = revealPart(part)
    length += revealed.length
    if (length > 8192) throw new TypeError('Secret HTTP value is too large')
    revealedParts.push(revealed)
  }
  return revealedParts.join('')
}

function revealPart(part: SecretHttpValue['parts'][number]): string {
  if (typeof part === 'string') return part
  if (!isRawStringSecret(part)) throw new TypeError('Secret HTTP value part is invalid')
  const revealed = part.reveal()
  if (typeof revealed !== 'string') throw new TypeError('Secret HTTP value part is invalid')
  return revealed
}

function isRawStringSecret(value: unknown): value is Extract<SecretHttpValue['parts'][number], object> {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'raw-secret'
    && 'redacted' in value
    && typeof value.redacted === 'string'
    && 'reveal' in value
    && typeof value.reveal === 'function'
    && 'toJSON' in value
    && typeof value.toJSON === 'function'
}
