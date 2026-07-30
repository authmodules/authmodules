import type { AuthProof, IdentityClaim, MethodRef } from '@authmodules/contracts/primitives'

export function makeProof(method: MethodRef, identity: IdentityClaim, now: Date): AuthProof {
  return {
    type: 'auth.proof',
    proofMethod: method,
    primaryIdentity: identity,
    evidence: [
      {
        kind: 'password',
        method
      }
    ],
    assurance: {
      level: 'medium',
      factors: ['password']
    },
    authTime: now
  }
}
