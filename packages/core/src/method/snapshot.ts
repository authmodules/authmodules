import type { DeliveryMessage } from '@authmodules/contracts/delivery'
import type { SideEffectRequest } from '@authmodules/contracts/effects'
import type { ChallengeMaterial, CredentialMaterial } from '@authmodules/contracts/material'
import type {
  MethodAuthenticateResult,
  MethodBeginResult,
  MethodCompleteResult,
  MethodEnrollResult
} from '@authmodules/contracts/method'
import type { AuthProof, IdentityClaim, PublicData } from '@authmodules/contracts/primitives'
import type {
  DeliveryData,
  PrivateData,
  ProtectedValue,
  RawSecretValue,
  SecretScalar,
  SealedSecretValue
} from '@authmodules/contracts/security'

const REDACTED = '[REDACTED]'

export function snapshotEnrollResult(value: MethodEnrollResult): MethodEnrollResult {
  return {
    identity: snapshotIdentity(value.identity),
    credentialMaterial: value.credentialMaterial
      ? snapshotMaterial(value.credentialMaterial)
      : undefined,
    proof: value.proof ? snapshotProof(value.proof) : undefined,
    sideEffects: value.sideEffects?.map(snapshotSideEffect),
    publicData: snapshotPublicData(value.publicData)
  }
}

export function snapshotAuthenticateResult(value: MethodAuthenticateResult): MethodAuthenticateResult {
  return {
    proof: snapshotProof(value.proof),
    credentialMaterial: value.credentialMaterial
      ? snapshotMaterial(value.credentialMaterial)
      : undefined,
    sideEffects: value.sideEffects?.map(snapshotSideEffect),
    publicData: snapshotPublicData(value.publicData)
  }
}

export function snapshotBeginResult(value: MethodBeginResult): MethodBeginResult {
  return {
    challengeMaterial: snapshotMaterial(value.challengeMaterial),
    expiresAt: new Date(value.expiresAt.getTime()),
    maxAttempts: value.maxAttempts,
    sideEffects: value.sideEffects?.map(snapshotSideEffect),
    publicData: snapshotPublicData(value.publicData)
  }
}

export function snapshotCompleteResult(value: MethodCompleteResult): MethodCompleteResult {
  return {
    proof: snapshotProof(value.proof),
    sideEffects: value.sideEffects?.map(snapshotSideEffect),
    publicData: snapshotPublicData(value.publicData)
  }
}

export function snapshotSideEffect(effect: SideEffectRequest): SideEffectRequest {
  const snapshot = {
    type: 'delivery' as const,
    message: snapshotDeliveryMessage(effect.message),
    expiresAt: effect.expiresAt ? new Date(effect.expiresAt.getTime()) : undefined
  }
  return effect.dispatchPolicy === 'required'
    ? {
        ...snapshot,
        dispatchPolicy: 'required',
        idempotencyKey: effect.idempotencyKey
      }
    : {
        ...snapshot,
        dispatchPolicy: 'best-effort',
        idempotencyKey: effect.idempotencyKey
      }
}

function snapshotIdentity(identity: IdentityClaim): IdentityClaim {
  return {
    methodId: identity.methodId,
    methodKind: identity.methodKind,
    subject: identity.subject,
    subjectKind: identity.subjectKind,
    display: identity.display,
    verifiedAt: identity.verifiedAt ? new Date(identity.verifiedAt.getTime()) : undefined
  }
}

function snapshotProof(proof: AuthProof): AuthProof {
  return structuredClone(proof)
}

export function snapshotMaterial(material: CredentialMaterial | ChallengeMaterial): CredentialMaterial {
  return {
    schemaVersion: material.schemaVersion,
    publicData: snapshotPublicData(material.publicData),
    privateData: snapshotPrivateData(material.privateData)
  }
}

function snapshotPrivateData(data: PrivateData | undefined): PrivateData | undefined {
  if (!data) return undefined
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    isProtectedValue(value)
      ? snapshotProtectedValue(value)
      : isSealedValue(value)
        ? snapshotSealedValue(value)
        : structuredClone(value)
  ]))
}

function snapshotDeliveryMessage(message: DeliveryMessage): DeliveryMessage {
  return {
    to: { ...message.to },
    templateId: message.templateId,
    data: snapshotDeliveryData(message.data),
    locale: message.locale,
    metadata: snapshotPublicData(message.metadata)
  }
}

function snapshotDeliveryData(data: DeliveryData | undefined): DeliveryData | undefined {
  if (!data) return undefined
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    isRawSecret(value) ? snapshotRawSecret(value) : structuredClone(value)
  ]))
}

function snapshotPublicData(value: PublicData | undefined): PublicData | undefined {
  return value ? structuredClone(value) : undefined
}

function snapshotRawSecret(value: RawSecretValue): RawSecretValue {
  const revealed = cloneSecretScalar(value.reveal())
  return {
    type: 'raw-secret',
    redacted: REDACTED,
    reveal() {
      return cloneSecretScalar(revealed)
    },
    toJSON() {
      return REDACTED
    }
  }
}

function snapshotProtectedValue(value: ProtectedValue): ProtectedValue {
  const verifier = value.revealForPersistence()
  if (typeof verifier !== 'string' || verifier.length === 0 || verifier.length > 1_000_000) {
    throw new TypeError('Protected value is invalid')
  }
  return {
    type: 'protected-value',
    scheme: value.scheme,
    redacted: REDACTED,
    keyId: value.keyId,
    createdAt: value.createdAt ? new Date(value.createdAt.getTime()) : undefined,
    revealForPersistence() {
      return verifier
    },
    toJSON() {
      return REDACTED
    }
  }
}

function snapshotSealedValue(value: SealedSecretValue): SealedSecretValue {
  const ciphertext = value.revealCiphertextForPersistence()
  if (typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext.length > 5_000_000) {
    throw new TypeError('Sealed value is invalid')
  }
  return {
    type: 'sealed-secret',
    algorithm: value.algorithm,
    keyId: value.keyId,
    redacted: REDACTED,
    expiresAt: value.expiresAt ? new Date(value.expiresAt.getTime()) : undefined,
    revealCiphertextForPersistence() {
      return ciphertext
    },
    toJSON() {
      return REDACTED
    }
  }
}

function cloneSecretScalar<T extends SecretScalar>(value: T): T {
  if (typeof value === 'string' && new TextEncoder().encode(value).byteLength <= 5_000_000) return value
  if (value instanceof Uint8Array && value.byteLength <= 5_000_000) return new Uint8Array(value) as T
  throw new TypeError('Raw secret value is invalid')
}

function isRawSecret(value: DeliveryData[string]): value is RawSecretValue {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'raw-secret'
}

function isProtectedValue(value: PrivateData[string]): value is ProtectedValue {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'protected-value'
}

function isSealedValue(value: PrivateData[string]): value is SealedSecretValue {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'sealed-secret'
}
