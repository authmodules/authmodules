export type CookieTokenCarrierOptions = {
  readonly name?: string
  readonly path?: string
  readonly domain?: string
  readonly sameSite?: 'lax' | 'strict' | 'none'
  readonly secure?: boolean
  readonly httpOnly?: boolean
}
