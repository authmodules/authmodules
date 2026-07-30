import {
  timingSafeEqual as nodeTimingSafeEqual,
  pbkdf2,
  randomBytes
} from 'node:crypto'
import type { HashPasswordInput, PasswordHasher, VerifyPasswordInput } from '@authmodules/contracts/crypto'
import type { ProtectedValue, RawSecretValue } from '@authmodules/contracts/security'
import { PBKDF2_SCHEME } from '../shared/constants.ts'
import { type NodePasswordHasherOptions } from './types.ts'
import { protectedValue } from '../values/factories.ts'
import { isValidDate } from '../shared/validation.ts'
import { cryptoFailure, err, ok } from '../shared/result.ts'

const MIN_ITERATIONS = 600_000
const MIN_KEY_LENGTH = 32

export function createNodePasswordHasher(options?: NodePasswordHasherOptions): PasswordHasher

export function createNodePasswordHasher(options: NodePasswordHasherOptions = {}): PasswordHasher {
  const iterations = options.iterations ?? 600_000
  const keyLength = options.keyLength ?? 32
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > 10_000_000
    || !Number.isSafeInteger(keyLength) || keyLength < MIN_KEY_LENGTH || keyLength > 128) {
    throw new TypeError('PBKDF2 options are invalid.')
  }

  return {
    async hashPassword(input: HashPasswordInput) {
      try {
        const password = boundedPassword(input?.password)
        if (!isValidDate(input?.now)) throw new TypeError('Password hash input is invalid')
        const salt = randomBytes(16).toString('base64url')
        const hash = (await derivePbkdf2(password, salt, iterations, keyLength)).toString('base64url')
        return ok(protectedValue({ type: 'protected-value', scheme: PBKDF2_SCHEME, value: `${iterations}.${salt}.${hash}`, createdAt: input.now }))
      } catch {
        return err(cryptoFailure('CRYPTO_FAILED'))
      }
    },
    async verifyPassword(input: VerifyPasswordInput) {
      try {
        const password = boundedPassword(input?.password)
        if (!isValidDate(input?.now)) throw new TypeError('Password verify input is invalid')
        const parsed = parsePbkdf2(input.protectedPassword)
        if (!parsed) {
          return err(cryptoFailure('CRYPTO_FAILED'))
        }
        const candidate = await derivePbkdf2(password, parsed.salt, parsed.iterations, parsed.hash.length)
        if (!nodeTimingSafeEqual(candidate, parsed.hash)) return ok({ verified: false })
        if (parsed.iterations >= iterations && parsed.hash.length >= keyLength) {
          return ok({ verified: true, needsRehash: false })
        }
        const salt = randomBytes(16).toString('base64url')
        const upgraded = await derivePbkdf2(password, salt, iterations, keyLength)
        return ok({
          verified: true,
          needsRehash: true,
          upgradedValue: protectedValue({
            type: 'protected-value',
            scheme: PBKDF2_SCHEME,
            value: `${iterations}.${salt}.${upgraded.toString('base64url')}`,
            createdAt: input.now
          })
        })
      } catch {
        return err(cryptoFailure('CRYPTO_FAILED'))
      }
    }
  }
}

function derivePbkdf2(password: string, salt: string, iterations: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject): void => {
    pbkdf2(password, salt, iterations, keyLength, 'sha256', (error: Error | null, derived: Buffer): void => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

function parsePbkdf2(protectedPassword: ProtectedValue): { iterations: number; salt: string; hash: Buffer } | null {
  if (!protectedPassword || protectedPassword.scheme !== PBKDF2_SCHEME
    || typeof protectedPassword.revealForPersistence !== 'function') {
    return null
  }
  let persisted
  try {
    persisted = protectedPassword.revealForPersistence()
  } catch {
    return null
  }
  if (typeof persisted !== 'string' || persisted.length > 1024) return null
  const parts = persisted.split('.')
  if (parts.length !== 3) return null
  const [iterationsRaw, salt, hashRaw] = parts
  const iterations = Number(iterationsRaw)
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > 10_000_000
    || !/^[A-Za-z0-9_-]{16,128}$/.test(salt)
    || !/^[A-Za-z0-9_-]{16,256}$/.test(hashRaw)) {
    return null
  }
  const hash = Buffer.from(hashRaw, 'base64url')
  if (hash.byteLength < 16 || hash.byteLength > 128 || hash.toString('base64url') !== hashRaw) return null
  return {
    iterations,
    salt,
    hash
  }
}

function boundedPassword(value: RawSecretValue<string>): string {
  if (!value || typeof value.reveal !== 'function') throw new TypeError('Password secret is invalid')
  const password = value.reveal()
  if (typeof password !== 'string' || password.length === 0 || password.length > 4096) {
    throw new TypeError('Password secret is invalid')
  }
  return password
}
