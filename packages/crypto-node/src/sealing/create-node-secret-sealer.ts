import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from 'node:crypto'
import type { SealInput, SecretSealer, UnsealInput } from '@authmodules/contracts/crypto'
import type { SecretScalar } from '@authmodules/contracts/security'
import { SEAL_ALGORITHM } from '../shared/constants.ts'
import { type NodeSecretSealerOptions } from './types.ts'
import { rawSecret, sealedValue } from '../values/factories.ts'
import { dateTimestamp, isSafeIdentifier } from '../shared/validation.ts'
import { revealSecret } from '../shared/encoding.ts'
import { cryptoFailure, err, ok } from '../shared/result.ts'

const maxSealedCiphertextCharacters = 5_000_000
const maxSealedPlaintextBytes = 3_749_969

export function createNodeSecretSealer(options: NodeSecretSealerOptions): SecretSealer

export function createNodeSecretSealer(options: NodeSecretSealerOptions): SecretSealer {
  if (!options || typeof options !== 'object') throw new TypeError('Secret sealer options are required')
  const key = normalizeAesKey(options.key)
  const keyId = options.keyId ?? 'default'
  if (!isSafeIdentifier(keyId, 512)) throw new TypeError('Secret sealer keyId is invalid')

  return {
    async seal<T extends SecretScalar = string>(input: SealInput<T>) {
      try {
        const purpose = input?.purpose
        const value = input?.value
        const expiresAtSource = input?.expiresAt
        const expiresAtTimestamp = expiresAtSource === undefined
          ? undefined
          : dateTimestamp(expiresAtSource)
        if (!isSafeIdentifier(purpose, 2048)
          || !value
          || value.type !== 'raw-secret'
          || typeof value.reveal !== 'function'
          || (expiresAtSource !== undefined && expiresAtTimestamp === undefined)) {
          return err(cryptoFailure('CRYPTO_FAILED'))
        }
        const expiresAt = expiresAtTimestamp === undefined ? undefined : new Date(expiresAtTimestamp)
        const plaintext = value.reveal()
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(sealAad(purpose, expiresAt))
        const encrypted = Buffer.concat([cipher.update(encodeSealedValue(plaintext)), cipher.final()])
        const tag = cipher.getAuthTag()
        const ciphertext = `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
        return ok(sealedValue({
          type: 'sealed-secret',
          algorithm: SEAL_ALGORITHM,
          keyId,
          ciphertext,
          expiresAt
        }))
      } catch {
        return err(cryptoFailure('CRYPTO_FAILED'))
      }
    },
    async unseal<T extends SecretScalar = string>(input: UnsealInput) {
      try {
        const purpose = input?.purpose
        const nowTimestamp = dateTimestamp(input?.now)
        const value = input?.value
        if (!value || typeof value !== 'object') {
          return err(cryptoFailure('CRYPTO_FAILED'))
        }
        const type = value.type
        const algorithm = value.algorithm
        const valueKeyId = value.keyId
        const expiresAtSource = value.expiresAt
        const expiresAtTimestamp = expiresAtSource === undefined
          ? undefined
          : dateTimestamp(expiresAtSource)
        const revealCiphertext = value.revealCiphertextForPersistence
        if (!isSafeIdentifier(purpose, 2048)
          || nowTimestamp === undefined
          || type !== 'sealed-secret'
          || algorithm !== SEAL_ALGORITHM
          || valueKeyId !== keyId
          || typeof revealCiphertext !== 'function'
          || (expiresAtSource !== undefined && expiresAtTimestamp === undefined)
          || (expiresAtTimestamp !== undefined && expiresAtTimestamp <= nowTimestamp)) {
          return err(cryptoFailure('CRYPTO_FAILED'))
        }
        const expiresAt = expiresAtTimestamp === undefined ? undefined : new Date(expiresAtTimestamp)
        const ciphertext = revealCiphertext.call(value)
        if (typeof ciphertext !== 'string'
          || ciphertext.length === 0
          || ciphertext.length > maxSealedCiphertextCharacters) {
          return err(cryptoFailure('CRYPTO_FAILED'))
        }
        const parts = ciphertext.split('.')
        if (parts.length !== 3 || !parts.every(isCanonicalBase64Url)) {
          return err(cryptoFailure('CRYPTO_FAILED'))
        }
        const [ivPart, tagPart, encryptedPart] = parts
        const iv = Buffer.from(ivPart, 'base64url')
        const tag = Buffer.from(tagPart, 'base64url')
        const encrypted = Buffer.from(encryptedPart, 'base64url')
        if (iv.byteLength !== 12 || tag.byteLength !== 16 || encrypted.byteLength < 1) {
          return err(cryptoFailure('CRYPTO_FAILED'))
        }
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(sealAad(purpose, expiresAt))
        decipher.setAuthTag(tag)
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
        return ok(rawSecret(decodeSealedValue(decrypted) as T))
      } catch {
        return err(cryptoFailure('CRYPTO_FAILED'))
      }
    }
  }
}

function isCanonicalBase64Url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  return Buffer.from(value, 'base64url').toString('base64url') === value
}

function encodeSealedValue(value: SecretScalar): Buffer {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxSealedPlaintextBytes) {
      throw new TypeError('Sealed value is too large.')
    }
    return Buffer.concat([Buffer.from([0]), Buffer.from(value, 'utf8')])
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > maxSealedPlaintextBytes) throw new TypeError('Sealed value is too large.')
    return Buffer.concat([Buffer.from([1]), Buffer.from(value)])
  }
  throw new TypeError('Sealed values must be strings or Uint8Array instances.')
}

function decodeSealedValue(value: Buffer): SecretScalar {
  if (value[0] === 0) return value.subarray(1).toString('utf8')
  if (value[0] === 1) return new Uint8Array(value.subarray(1))
  throw new TypeError('Sealed value encoding is invalid.')
}

function sealAad(purpose: string, expiresAt?: Date): Buffer {
  return Buffer.from(`${purpose}\u0000${expiresAt?.toISOString() ?? ''}`, 'utf8')
}

function normalizeAesKey(key: NodeSecretSealerOptions['key']): Buffer {
  const raw = revealSecret(key)
  if (!(raw instanceof Uint8Array) || raw.byteLength !== 32) {
    throw new TypeError('AES-256-GCM key must be exactly 32 bytes.')
  }
  return Buffer.from(raw)
}
