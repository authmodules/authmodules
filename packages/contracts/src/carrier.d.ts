import type { Result } from './result.js'
import type { RawSecretValue } from './security.js'
import type { CarrierFailure } from './errors.js'

export type HttpRequestView = {
  /** Header names must be lower-case. Framework adapters must normalize them. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly cookies?: Readonly<Record<string, string | undefined>>
}

export type HttpValuePart = string | RawSecretValue<string>

/** Header-safe value. Raw parts are revealed only by the framework adapter during final response write. */
export type SecretHttpValue = {
  readonly parts: readonly HttpValuePart[]
}

export type SetCookieDescriptor = {
  readonly name: string
  readonly value: RawSecretValue<string>
  readonly httpOnly?: boolean
  readonly secure?: boolean
  readonly sameSite?: 'lax' | 'strict' | 'none'
  readonly path?: string
  readonly domain?: string
  readonly maxAgeSeconds?: number
  readonly expires?: Date
}

export type ClearCookieDescriptor = {
  readonly name: string
  readonly path?: string
  readonly domain?: string
  readonly secure?: boolean
}

export type HttpMutation =
  | { readonly type: 'set-header'; readonly name: string; readonly value: SecretHttpValue }
  | { readonly type: 'append-header'; readonly name: string; readonly value: SecretHttpValue }
  | { readonly type: 'set-cookie'; readonly cookie: SetCookieDescriptor }
  | { readonly type: 'clear-cookie'; readonly cookie: ClearCookieDescriptor }

export type TokenCarrierReadResult =
  | { readonly found: true; readonly token: RawSecretValue<string> }
  | { readonly found: false }

export type TokenCarrierSetInput = {
  readonly token: RawSecretValue<string>
  readonly expiresAt?: Date
}

export type TokenCarrierClearInput = {
  readonly reason?: string
}

export interface HttpTokenCarrier {
  read(input: HttpRequestView): Result<TokenCarrierReadResult, CarrierFailure>
  createSetInstructions(input: TokenCarrierSetInput): Result<readonly HttpMutation[], CarrierFailure>
  createClearInstructions(input?: TokenCarrierClearInput): Result<readonly HttpMutation[], CarrierFailure>
}
