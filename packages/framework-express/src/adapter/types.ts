import type {
  HttpMutation,
  HttpRequestView,
  HttpTokenCarrier,
  TokenCarrierReadResult
} from '@authmodules/contracts/carrier'
import type { Auth } from '@authmodules/contracts/core'
import type { CarrierFailure, PublicAuthError } from '@authmodules/contracts/errors'
import type { AuthContext, TenantId } from '@authmodules/contracts/primitives'
import type { Result } from '@authmodules/contracts/result'

export type ExpressLikeRequest = {
  readonly headers?: Record<string, string | readonly string[] | undefined>
  readonly cookies?: Record<string, string | undefined>
  readonly ip?: string
  readonly authActor?: AuthContext['actor']
  readonly authMetadata?: AuthContext['metadata']
  readonly authPolicyInput?: AuthContext['policyInput']
}

export type ExpressLikeResponse = {
  setHeader(name: string, value: string | readonly string[]): void
  getHeader?(name: string): string | readonly string[] | number | undefined
}

export type ExpressAuthAdapter = {
  readonly auth: Auth
  readonly carrier: HttpTokenCarrier
  toAuthContext(req: ExpressLikeRequest): AuthContext
  toHttpRequestView(req: ExpressLikeRequest): HttpRequestView
  readToken(req: ExpressLikeRequest): Result<TokenCarrierReadResult, CarrierFailure>
  applyHttpMutations(res: ExpressLikeResponse, mutations: readonly HttpMutation[]): void
  getSession(req: ExpressLikeRequest): Promise<Awaited<ReturnType<Auth['getSession']>>>
  publicError(error: { readonly publicError: PublicAuthError }): PublicAuthError
}

export type ExpressAuthAdapterOptions = {
  readonly auth: Auth
  readonly carrier: HttpTokenCarrier
  readonly tenantResolver: (req: ExpressLikeRequest) => TenantId
}
