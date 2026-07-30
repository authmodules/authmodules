import type {
  HttpMutation
} from '@authmodules/contracts/carrier'
import { type ExpressLikeResponse } from '../adapter/types.ts'
import { safeHeaderName, safeHeaderValue } from './headers.ts'
import { serializeClearCookie, serializeSetCookie } from '../cookies/serialize.ts'
import { revealSecretHttpValue } from '../security/reveal-secret-http-value.ts'

export function applyHttpMutations(res: ExpressLikeResponse, mutations: readonly HttpMutation[]): void {
  if (!res || typeof res.setHeader !== 'function') throw new TypeError('Response is invalid')
  if (!Array.isArray(mutations) || mutations.length > 1000) throw new TypeError('HTTP mutations are invalid')
  const staged = new Map<string, { readonly name: string; readonly value: string | readonly string[] }>()
  for (const mutation of mutations) {
    if (mutation.type === 'set-header') {
      stageHeader(staged, safeHeaderName(mutation.name), safeHeaderValue(revealSecretHttpValue(mutation.value)))
    } else if (mutation.type === 'append-header') {
      const name = safeHeaderName(mutation.name)
      const next = safeHeaderValue(revealSecretHttpValue(mutation.value))
      stageAppendedHeader(res, staged, name, next)
    } else if (mutation.type === 'set-cookie') {
      stageAppendedHeader(res, staged, 'set-cookie', safeHeaderValue(serializeSetCookie(mutation.cookie)))
    } else if (mutation.type === 'clear-cookie') {
      stageAppendedHeader(res, staged, 'set-cookie', safeHeaderValue(serializeClearCookie(mutation.cookie)))
    } else {
      throw new TypeError('HTTP mutation type is invalid')
    }
  }
  for (const { name, value } of staged.values()) res.setHeader(name, value)
}

function stageHeader(
  staged: Map<string, { readonly name: string; readonly value: string | readonly string[] }>,
  name: string,
  value: string | readonly string[]
): void {
  staged.set(name.toLowerCase(), { name, value })
}

function stageAppendedHeader(
  res: ExpressLikeResponse,
  staged: Map<string, { readonly name: string; readonly value: string | readonly string[] }>,
  name: string,
  value: string
): void {
  const stagedValue = staged.get(name.toLowerCase())?.value
  const previous = stagedValue ?? res.getHeader?.(name)
  if (previous === undefined) {
    stageHeader(staged, name, value)
  } else if (Array.isArray(previous)) {
    stageHeader(staged, name, [...previous.map((item) => safeHeaderValue(String(item))), value])
  } else {
    stageHeader(staged, name, [safeHeaderValue(String(previous)), value])
  }
}
