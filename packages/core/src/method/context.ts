import type { AuthContext, IdentityLookup, MethodRef } from '@authmodules/contracts/primitives'
import type {
  MethodExecutionContext,
  MethodIdentityContext,
  MethodValidationContext
} from '@authmodules/contracts/method'
import { decisionAuthContext } from '../shared/context.ts'
import { snapshotMaterial } from './snapshot.ts'

export function validationContext(method: MethodRef, auth: AuthContext, now: Date): MethodValidationContext {
  return {
    method: { ...method },
    auth: decisionAuthContext(auth),
    now: new Date(now.getTime())
  }
}

export function executionContext(
  method: MethodRef,
  auth: AuthContext,
  now: Date,
  lookup?: IdentityLookup,
  identity?: MethodIdentityContext
): MethodExecutionContext {
  return {
    method: { ...method },
    auth: decisionAuthContext(auth),
    now: new Date(now.getTime()),
    lookup: lookup ? { ...lookup } : undefined,
    identity: identity
      ? {
          identityId: identity.identityId,
          credentialId: identity.credentialId,
          credentialMaterial: identity.credentialMaterial
            ? snapshotMaterial(identity.credentialMaterial)
            : undefined
        }
      : undefined
  }
}

export function toMethodRef(method?: MethodRef): MethodRef {
  return method ? { methodId: method.methodId, methodKind: method.methodKind } : { methodId: 'unknown', methodKind: 'unknown' }
}
