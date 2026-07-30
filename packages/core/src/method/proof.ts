import type { MethodBeginResult } from '@authmodules/contracts/method'
import type { AuthEvidence, AuthProof, IdentityClaim, IdentityLookup, MethodRef } from '@authmodules/contracts/primitives'
import { identityKeyForProof } from '../accounts/resolve.ts'
import { isStableMethodId } from '../validation/method.ts'
import { isNonEmptyString, isPublicData, isValidDate } from '../validation/input.ts'
import { isIdentityClaim, isMethodMaterial } from '../validation/method-data.ts'
import { isSideEffects } from '../validation/side-effects.ts'

const assuranceKeys = new Set(['factors', 'level'])
const evidenceKeys = new Set(['details', 'kind', 'method'])
const methodRefKeys = new Set(['methodId', 'methodKind'])
const proofKeys = new Set([
  'additionalIdentities',
  'assurance',
  'authTime',
  'claims',
  'evidence',
  'expiresAt',
  'primaryIdentity',
  'proofMethod',
  'type'
])

export function proofMatches(method: MethodRef, lookup: IdentityLookup | undefined, proof: unknown, now: Date): proof is AuthProof {
  if (!isRecord(proof) || !hasOnlyKeys(proof, proofKeys) || proof.type !== 'auth.proof') return false
  if (!isRecord(proof.proofMethod) || !hasOnlyKeys(proof.proofMethod, methodRefKeys)) return false
  if (proof.proofMethod?.methodId !== method.methodId || proof.proofMethod?.methodKind !== method.methodKind) return false
  if (!isValidDate(proof.authTime) || proof.authTime > now) return false
  if (proof.expiresAt !== undefined) {
    if (!isValidDate(proof.expiresAt) || proof.expiresAt <= now || proof.authTime > proof.expiresAt) return false
  }
  if (!isIdentityClaim(proof.primaryIdentity, now)
    || !identityMatchesMethod(method, proof.primaryIdentity)
    || !identityMatches(lookup, proof.primaryIdentity)) return false

  const seen = new Set([identityKeyForProof(proof.primaryIdentity)])
  if (proof.additionalIdentities !== undefined && !isBoundedDenseArray(proof.additionalIdentities, 100)) return false
  for (const identity of proof.additionalIdentities ?? []) {
    if (!isIdentityClaim(identity, now)) return false
    const key = identityKeyForProof(identity)
    if (seen.has(key)) return false
    seen.add(key)
  }

  if (!isBoundedDenseArray(proof.evidence, 100) || !proof.evidence.every(isEvidence)) return false
  if (!isPublicData(proof.claims)) return false
  if (proof.assurance !== undefined && !isAssurance(proof.assurance)) return false
  return true
}

export function identityMatchesMethod(method: MethodRef | undefined, identity: IdentityClaim | undefined): boolean {
  return Boolean(
    method
    && identity
    && method.methodId === identity.methodId
    && method.methodKind === identity.methodKind
  )
}

export function isValidBeginOutput(value: unknown, now: Date): value is MethodBeginResult {
  return isRecord(value)
    && value.expiresAt instanceof Date
    && value.expiresAt > now
    && Number.isSafeInteger(value.maxAttempts)
    && typeof value.maxAttempts === 'number'
    && value.maxAttempts > 0
    && value.maxAttempts <= 1_000_000
    && value.challengeMaterial !== undefined
    && isMethodMaterial(value.challengeMaterial)
    && isSideEffects(value.sideEffects)
}

export function identityMatches(left: IdentityLookup | undefined, right: IdentityLookup | undefined): boolean {
  if (!left) return true
  if (!right) return false
  return left.methodId === right.methodId
    && left.methodKind === right.methodKind
    && left.subject === right.subject
    && left.subjectKind === right.subjectKind
}

function isEvidence(evidence: unknown): evidence is AuthEvidence {
  return isRecord(evidence)
    && hasOnlyKeys(evidence, evidenceKeys)
    && isRecord(evidence.method)
    && hasOnlyKeys(evidence.method, methodRefKeys)
    && isNonEmptyString(evidence.kind)
    && isStableMethodId(evidence.method?.methodId)
    && isNonEmptyString(evidence.method?.methodKind)
    && isPublicData(evidence.details)
}

function isAssurance(assurance: unknown): assurance is AuthProof['assurance'] {
  return isRecord(assurance)
    && hasOnlyKeys(assurance, assuranceKeys)
    && (assurance.level === 'low' || assurance.level === 'medium' || assurance.level === 'high')
    && (assurance.factors === undefined
      || (isBoundedDenseArray(assurance.factors, 32) && assurance.factors.every(isNonEmptyString)))
}

function isBoundedDenseArray(value: unknown, maxLength: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) return false
  const keys = Object.keys(value)
  return keys.length === value.length && keys.every((key, index) => key === String(index))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
