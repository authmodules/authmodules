import {
  createHash,
  createHmac,
  timingSafeEqual as nodeTimingSafeEqual,
  randomBytes
} from 'node:crypto'
import type {
  CryptoProvider,
  HashInput,
  HmacInput,
  RandomStringOptions,
  VerifyHmacInput
} from '@authmodules/contracts/crypto'
import {
  HASH_SCHEME,
  HMAC_LEGACY_FRAMING,
  HMAC_SCHEME
} from '../shared/constants.ts'
import { protectedValue, rawSecret } from '../values/factories.ts'
import { assertByteLength } from '../shared/validation.ts'
import { revealSecret, toBuffer } from '../shared/encoding.ts'
import { cryptoFailure, err, ok } from '../shared/result.ts'

export function createNodeCryptoProvider(): CryptoProvider

export function createNodeCryptoProvider(): CryptoProvider {
  return {
    randomPublicBytes(size: number): Uint8Array {
      assertByteLength(size)
      return randomBytes(size)
    },
    randomSecretBytes(size: number) {
      assertByteLength(size)
      return rawSecret(randomBytes(size))
    },
    randomSecretString(options: RandomStringOptions) {
      if (options?.kind === 'base64url') {
        if (!Number.isSafeInteger(options.bytes) || options.bytes <= 0 || options.bytes > 1_048_576) {
          throw new TypeError('Secret byte length must be a positive integer.')
        }
        return rawSecret(randomBytes(options.bytes).toString('base64url'))
      }
      if (typeof options.alphabet !== 'string'
        || options.alphabet.length < 2
        || options.alphabet.length > 256
        || new Set(options.alphabet).size !== options.alphabet.length
        || !Number.isSafeInteger(options.length)
        || options.length <= 0
        || options.length > 1_048_576) {
        throw new TypeError('Secret alphabet options are invalid.')
      }

      let output = ''
      const unbiasedLimit = 256 - (256 % options.alphabet.length)
      while (output.length < options.length) {
        const bytes = randomBytes(Math.max(16, (options.length - output.length) * 2))
        for (const byte of bytes) {
          if (byte >= unbiasedLimit) continue
          output += options.alphabet[byte % options.alphabet.length]
          if (output.length === options.length) break
        }
      }
      return rawSecret(output)
    },
    async hash(input: HashInput) {
      try {
        const value = revealSecret(input.value)
        const digest = createHash('sha256').update(toBuffer(value)).digest('base64url')
        return ok(protectedValue({ type: 'protected-value', scheme: input.scheme ?? HASH_SCHEME, value: digest }))
      } catch {
        return err(cryptoFailure('CRYPTO_FAILED'))
      }
    },
    async hmac(input: HmacInput) {
      try {
        if (input.framing !== HMAC_SCHEME) {
          throw new TypeError('HMAC framing is invalid')
        }
        const material = hmacMaterial(input)
        const digest = hmacDigest(material, HMAC_SCHEME).toString('base64url')
        return ok(protectedValue({ type: 'protected-value', scheme: input.scheme ?? HMAC_SCHEME, value: digest }))
      } catch {
        return err(cryptoFailure('CRYPTO_FAILED'))
      }
    },
    async verifyHmac(input: VerifyHmacInput) {
      try {
        if (input.framing !== HMAC_SCHEME && input.framing !== HMAC_LEGACY_FRAMING) {
          throw new TypeError('HMAC framing is invalid')
        }
        if (!isSafeScheme(input.scheme)
          || (input.framing === 'hmac-sha256.legacy.v1'
            && (!isSafeScheme(input.upgradeScheme) || input.upgradeScheme === input.scheme))) {
          throw new TypeError('HMAC scheme is invalid')
        }
        const protectedHmac = snapshotProtectedHmacValue(input.protectedValue)
        if (!protectedHmac) {
          throw new TypeError('Protected HMAC value is invalid')
        }
        if (protectedHmac.scheme !== input.scheme) {
          return ok({ verified: false } as const)
        }
        const material = hmacMaterial(input)
        const candidate = hmacDigest(material, input.framing)
        if (!nodeTimingSafeEqual(candidate, protectedHmac.persisted)) {
          return ok({ verified: false } as const)
        }
        if (input.framing === HMAC_SCHEME) {
          return ok({ verified: true, needsUpgrade: false } as const)
        }
        const upgradedDigest = hmacDigest(material, HMAC_SCHEME).toString('base64url')
        return ok({
          verified: true,
          needsUpgrade: true,
          upgradedValue: protectedValue({
            type: 'protected-value',
            scheme: input.upgradeScheme,
            value: upgradedDigest
          })
        } as const)
      } catch {
        return err(cryptoFailure('CRYPTO_FAILED'))
      }
    },
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
      if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false
      if (a.byteLength !== b.byteLength) {
        return false
      }
      return nodeTimingSafeEqual(a, b)
    }
  }
}

type HmacMaterial = {
  readonly key: Buffer
  readonly value: Buffer
  readonly context?: Buffer
}

function hmacMaterial(input: Pick<HmacInput, 'context' | 'key' | 'value'>): HmacMaterial {
  if (input.context !== undefined && (
    typeof input.context !== 'string'
    || input.context.length === 0
    || input.context.length > 4096
    || /[\u0000-\u001f\u007f]/.test(input.context)
  )) {
    throw new TypeError('HMAC context is invalid')
  }
  const key = toBuffer(revealSecret(input.key))
  const value = toBuffer(revealSecret(input.value))
  if (key.byteLength === 0 || key.byteLength > 1_048_576 || value.byteLength > 5_242_880) {
    throw new TypeError('HMAC input is invalid')
  }
  return {
    key,
    value,
    context: input.context === undefined ? undefined : Buffer.from(input.context)
  }
}

function hmacDigest(
  material: HmacMaterial,
  framing: 'hmac-sha256.v2' | 'hmac-sha256.legacy.v1'
): Buffer {
  const hmac = createHmac('sha256', material.key)
  if (framing === 'hmac-sha256.legacy.v1') {
    if (material.context !== undefined) {
      hmac.update(`authmodules.hmac.context.v1\u0000${material.context.byteLength}\u0000`)
      hmac.update(material.context)
      hmac.update('\u0000')
    }
    return hmac.update(material.value).digest()
  }
  hmac.update('authmodules.hmac.v2\u0000')
  hmac.update(Buffer.from([material.context === undefined ? 0 : 1]))
  hmac.update(unsignedLength(material.context?.byteLength ?? 0))
  if (material.context !== undefined) hmac.update(material.context)
  hmac.update(unsignedLength(material.value.byteLength))
  return hmac.update(material.value).digest()
}

function unsignedLength(value: number): Buffer {
  const output = Buffer.alloc(4)
  output.writeUInt32BE(value)
  return output
}

function isSafeScheme(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function snapshotProtectedHmacValue(value: unknown): {
  readonly scheme: string
  readonly persisted: Buffer
} | undefined {
  if (!isRecord(value)
    || value.type !== 'protected-value'
    || typeof value.revealForPersistence !== 'function') {
    return undefined
  }
  try {
    const scheme = value.scheme
    const persistedText = value.revealForPersistence()
    if (!isSafeScheme(scheme)
      || typeof persistedText !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(persistedText)) return undefined
    const persisted = Buffer.from(persistedText, 'base64url')
    return persisted.byteLength === 32 && persisted.toString('base64url') === persistedText
      ? { scheme, persisted }
      : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
