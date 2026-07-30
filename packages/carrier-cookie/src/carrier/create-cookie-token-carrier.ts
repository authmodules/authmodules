import type {
  HttpRequestView,
  HttpTokenCarrier,
  TokenCarrierClearInput,
  TokenCarrierSetInput
} from '@authmodules/contracts/carrier'
import { isCookieDomain, isCookiePath } from '../cookies/validation.ts'
import { rawSecret } from '../security/raw-secret.ts'
import { carrierErr, ok } from '../shared/result.ts'
import type { CookieTokenCarrierOptions } from './types.ts'

const cookieOctet = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/

export function createCookieTokenCarrier(options?: CookieTokenCarrierOptions): HttpTokenCarrier
export function createCookieTokenCarrier(options: CookieTokenCarrierOptions = {}): HttpTokenCarrier {
  const name = options.name ?? 'am_session'
  const path = options.path ?? '/'
  const sameSite = options.sameSite ?? 'lax'
  const secure = options.secure ?? true
  const httpOnly = options.httpOnly ?? true
  const domain = options.domain
  if (typeof name !== 'string' || name.length > 256 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new TypeError('Cookie name is invalid')
  }
  if (!isCookiePath(path)) throw new TypeError('Cookie path is invalid')
  if (domain !== undefined && !isCookieDomain(domain)) throw new TypeError('Cookie domain is invalid')
  if (!['lax', 'strict', 'none'].includes(sameSite)) throw new TypeError('Cookie sameSite is invalid')
  if (typeof secure !== 'boolean' || typeof httpOnly !== 'boolean') throw new TypeError('Cookie flags must be boolean')
  if (sameSite === 'none' && !secure) throw new TypeError('SameSite=None cookies must be Secure')
  if (name.startsWith('__Secure-') && !secure) throw new TypeError('__Secure- cookies must be Secure')
  if (name.startsWith('__Host-') && (!secure || path !== '/' || domain !== undefined)) {
    throw new TypeError('__Host- cookies must be Secure, use Path=/, and omit Domain')
  }

  return {
    read(input?: HttpRequestView) {
      try {
        if (!input || typeof input !== 'object' || (input.cookies !== undefined && (!input.cookies || typeof input.cookies !== 'object' || Array.isArray(input.cookies)))) {
          return carrierErr('VALIDATION_FAILED')
        }
        const cookies = input.cookies
        if (!cookies || !Object.hasOwn(cookies, name)) {
          return ok({ found: false })
        }
        const value = cookies[name]
        if (value === undefined || value === '') {
          return ok({ found: false })
        }
        if (typeof value !== 'string' || value.length > 8192 || !cookieOctet.test(value)) {
          return carrierErr('VALIDATION_FAILED')
        }
        return ok({ found: true, token: rawSecret(value) })
      } catch {
        return carrierErr('VALIDATION_FAILED')
      }
    },
    createSetInstructions(input?: TokenCarrierSetInput) {
      try {
        const token = readRawToken(input?.token)
        const expiresAtSource = input?.expiresAt
        let expiresAt: Date | undefined
        if (expiresAtSource !== undefined) {
          if (!(expiresAtSource instanceof Date)) return carrierErr('VALIDATION_FAILED')
          const timestamp = Date.prototype.getTime.call(expiresAtSource)
          if (!Number.isFinite(timestamp)) return carrierErr('VALIDATION_FAILED')
          expiresAt = new Date(timestamp)
        }
        if (token === null) {
          return carrierErr('VALIDATION_FAILED')
        }
        return ok([
          {
            type: 'set-cookie',
            cookie: {
              name,
              value: rawSecret(token),
              httpOnly,
              secure,
              sameSite,
              path,
              domain,
              expires: expiresAt
            }
          }
        ])
      } catch {
        return carrierErr('VALIDATION_FAILED')
      }
    },
    createClearInstructions(_input?: TokenCarrierClearInput) {
      return ok([
        {
          type: 'clear-cookie',
          cookie: {
            name,
            path,
            domain,
            secure
          }
        }
      ])
    }
  }
}

const rawSecretKeys = new Set(['redacted', 'reveal', 'toJSON', 'type'])

function readRawToken(value: unknown): string | null {
  try {
    if (!isRecord(value)
      || !Object.keys(value).every((key) => rawSecretKeys.has(key))
      || value.type !== 'raw-secret'
      || typeof value.redacted !== 'string'
      || typeof value.reveal !== 'function'
      || typeof value.toJSON !== 'function') return null
    const token = value.reveal()
    return typeof token === 'string'
      && token.length > 0
      && token.length <= 4096
      && cookieOctet.test(token)
      ? token
      : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
