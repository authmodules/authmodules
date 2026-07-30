import type { HttpMutation } from '@authmodules/contracts/carrier'
import type { PublicAuthError } from '@authmodules/contracts/errors'
import { type ExpressAuthAdapter, type ExpressAuthAdapterOptions } from './types.ts'
import type { ExpressLikeRequest, ExpressLikeResponse } from './types.ts'
import { resolvedTenant, safeCarrierRead } from './dependencies.ts'
import { toAuthContext, toHttpRequestView } from '../http/request.ts'
import { applyHttpMutations } from '../http/response.ts'
import { authFailure } from '../shared/errors.ts'

export function createExpressAuthAdapter(options: ExpressAuthAdapterOptions): ExpressAuthAdapter

export function createExpressAuthAdapter(options?: ExpressAuthAdapterOptions): ExpressAuthAdapter {
  if (!options) throw new TypeError('Express adapter options are required')
  const config: Partial<ExpressAuthAdapterOptions> = options
  const auth = config.auth
  const carrier = config.carrier
  const tenantResolver = config.tenantResolver
  if (!auth || typeof auth.getSession !== 'function') throw new TypeError('Auth instance is required')
  if (!carrier || typeof carrier.read !== 'function') throw new TypeError('Token carrier is required')
  if (typeof tenantResolver !== 'function') throw new TypeError('tenantResolver is required')

  return {
    auth,
    carrier,
    toAuthContext(req: ExpressLikeRequest) {
      return toAuthContext(req, resolvedTenant(tenantResolver, req))
    },
    toHttpRequestView(req: ExpressLikeRequest) {
      return toHttpRequestView(req)
    },
    readToken(req: ExpressLikeRequest) {
      return safeCarrierRead(carrier, req)
    },
    applyHttpMutations(res: ExpressLikeResponse, mutations: readonly HttpMutation[]): void {
      applyHttpMutations(res, mutations)
    },
    async getSession(req: ExpressLikeRequest) {
      const token = safeCarrierRead(carrier, req)
      if (!token.ok) {
        return authFailure(token.error.reason, 'SESSION_INVALID')
      }
      try {
        return await auth.getSession({
          context: toAuthContext(req, resolvedTenant(tenantResolver, req)),
          token: token.value.found ? token.value.token : undefined
        })
      } catch {
        return authFailure('INTERNAL', 'INTERNAL')
      }
    },
    publicError(error: { readonly publicError: PublicAuthError }): PublicAuthError {
      return error.publicError
    }
  }
}
