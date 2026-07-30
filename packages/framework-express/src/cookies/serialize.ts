import type { ClearCookieDescriptor, SetCookieDescriptor } from '@authmodules/contracts/carrier'

export function serializeSetCookie(cookie: SetCookieDescriptor): string {
  const snapshot = snapshotSetCookie(cookie)
  validateSetCookie(snapshot)
  const value = snapshot.value.reveal()
  if (typeof value !== 'string'
    || value.length > 4096
    || /[\u0000-\u001f\u007f;]/.test(value)
    || hasUnpairedSurrogate(value)) {
    throw new TypeError('Cookie value is invalid')
  }
  const parts = [`${snapshot.name}=${encodeURIComponent(value)}`]
  if (snapshot.maxAgeSeconds !== undefined) parts.push(`Max-Age=${snapshot.maxAgeSeconds}`)
  if (snapshot.expires) parts.push(`Expires=${snapshot.expires.toUTCString()}`)
  if (snapshot.domain) parts.push(`Domain=${snapshot.domain}`)
  if (snapshot.path) parts.push(`Path=${snapshot.path}`)
  if (snapshot.httpOnly !== false) parts.push('HttpOnly')
  if (snapshot.secure !== false) parts.push('Secure')
  if (snapshot.sameSite) parts.push(`SameSite=${capitalize(snapshot.sameSite)}`)
  return parts.join('; ')
}

export function serializeClearCookie(cookie: ClearCookieDescriptor): string {
  const snapshot = snapshotClearCookie(cookie)
  validateCookieScope(snapshot)
  const parts = [`${snapshot.name}=`, 'Max-Age=0', `Expires=${new Date(0).toUTCString()}`]
  if (snapshot.domain) parts.push(`Domain=${snapshot.domain}`)
  if (snapshot.path) parts.push(`Path=${snapshot.path}`)
  if (snapshot.secure) parts.push('Secure')
  return parts.join('; ')
}

function snapshotSetCookie(value: unknown): SetCookieDescriptor {
  if (!isRecord(value)) throw new TypeError('Cookie descriptor is invalid')
  const name = value.name
  const secret = value.value
  const path = value.path
  const domain = value.domain
  const httpOnly = value.httpOnly
  const secure = value.secure
  const sameSite = value.sameSite
  const maxAgeSeconds = value.maxAgeSeconds
  const expiresValue = value.expires
  const expires = expiresValue instanceof Date
    ? new Date(expiresValue.getTime())
    : expiresValue
  return {
    name,
    value: snapshotRawStringSecret(secret),
    path,
    domain,
    httpOnly,
    secure,
    sameSite,
    maxAgeSeconds,
    expires
  } as SetCookieDescriptor
}

function snapshotClearCookie(value: unknown): ClearCookieDescriptor {
  if (!isRecord(value)) throw new TypeError('Cookie descriptor is invalid')
  const name = value.name
  const path = value.path
  const domain = value.domain
  const secure = value.secure
  return { name, path, domain, secure } as ClearCookieDescriptor
}

function snapshotRawStringSecret(value: unknown): SetCookieDescriptor['value'] {
  if (!isRecord(value)) throw new TypeError('Cookie value is invalid')
  const type = value.type
  const reveal = value.reveal
  if (type !== 'raw-secret' || typeof reveal !== 'function') {
    throw new TypeError('Cookie value is invalid')
  }
  const revealed = Reflect.apply(reveal, value, [])
  if (typeof revealed !== 'string') throw new TypeError('Cookie value is invalid')
  return Object.freeze({
    type: 'raw-secret' as const,
    redacted: '[REDACTED]',
    reveal() {
      return revealed
    },
    toJSON() {
      return '[REDACTED]'
    }
  })
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function validateSetCookie(cookie: unknown): asserts cookie is SetCookieDescriptor {
  validateCookieScope(cookie)
  if (!isRawStringSecret(cookie.value)) throw new TypeError('Cookie value is invalid')
  if (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean') throw new TypeError('Cookie httpOnly is invalid')
  if (cookie.secure !== undefined && typeof cookie.secure !== 'boolean') throw new TypeError('Cookie secure is invalid')
  const sameSite = cookie.sameSite
  if (sameSite !== undefined && (typeof sameSite !== 'string' || !['lax', 'strict', 'none'].includes(sameSite))) {
    throw new TypeError('Cookie sameSite is invalid')
  }
  if (sameSite === 'none' && cookie.secure !== true) {
    throw new TypeError('SameSite=None cookie must be Secure')
  }
  const maxAgeSeconds = cookie.maxAgeSeconds
  if (maxAgeSeconds !== undefined
    && (typeof maxAgeSeconds !== 'number' || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0)) {
    throw new TypeError('Cookie maxAgeSeconds is invalid')
  }
  if (cookie.expires !== undefined && (!(cookie.expires instanceof Date) || Number.isNaN(cookie.expires.getTime()))) {
    throw new TypeError('Cookie expires is invalid')
  }
}

function validateCookieScope(cookie: unknown): asserts cookie is CookieScope {
  if (!isRecord(cookie)) throw new TypeError('Cookie descriptor is invalid')
  if (typeof cookie.name !== 'string' || cookie.name.length > 256 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name)) {
    throw new TypeError('Cookie name is invalid')
  }
  if (cookie.path !== undefined && (
    typeof cookie.path !== 'string'
    || cookie.path.length > 2048
    || !/^\/[\x20-\x3A\x3C-\x7E]*$/.test(cookie.path)
  )) {
    throw new TypeError('Cookie path is invalid')
  }
  if (cookie.domain !== undefined && !isCookieDomain(cookie.domain)) throw new TypeError('Cookie domain is invalid')
  if (cookie.secure !== undefined && typeof cookie.secure !== 'boolean') throw new TypeError('Cookie secure is invalid')
  if (cookie.name.startsWith('__Secure-') && cookie.secure !== true) {
    throw new TypeError('__Secure- cookies must be cleared with Secure')
  }
  if (cookie.name.startsWith('__Host-')
    && (cookie.secure !== true || cookie.path !== '/' || cookie.domain !== undefined)) {
    throw new TypeError('__Host- cookies must be cleared with Secure, Path=/, and no Domain')
  }
}

function isCookieDomain(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253 || /[\r\n;\s]/.test(value)) return false
  const normalized = value.startsWith('.') ? value.slice(1) : value
  if (normalized.length === 0) return false
  return normalized.split('.').every((label) => (
    label.length > 0 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ))
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

type CookieScope = ClearCookieDescriptor & Record<string, unknown>

function isRawStringSecret(value: unknown): value is SetCookieDescriptor['value'] {
  return isRecord(value)
    && value.type === 'raw-secret'
    && typeof value.redacted === 'string'
    && typeof value.reveal === 'function'
    && typeof value.toJSON === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
