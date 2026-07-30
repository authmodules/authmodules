import type { CryptoProvider } from '@authmodules/contracts/crypto'
import type {
  MethodBeginOperation,
  MethodCompleteOperation
} from '@authmodules/contracts/method'
import type {
  DecisionAuthContext,
  IdentityLookup,
  PublicData
} from '@authmodules/contracts/primitives'
import type { RawSecretValue } from '@authmodules/contracts/security'

export type OtpBeginInput = {
  readonly subject: string
  readonly display?: string
  readonly locale?: string
  readonly publicData?: PublicData
}

export type OtpCompleteInput = {
  readonly code: RawSecretValue<string>
  readonly publicData?: PublicData
}

export type OtpMethodOptions = {
  readonly methodId?: string
  readonly subjectKind?: string
  readonly channel?: string
  readonly templateId?: string
  readonly ttlSeconds?: number
  readonly maxAttempts?: number
  readonly alphabet?: string
  readonly codeLength?: number
  readonly crypto: CryptoProvider
  readonly verificationKey: RawSecretValue<string | Uint8Array>
  readonly resolveDeliveryTarget?: (input: {
    readonly lookup: IdentityLookup
    readonly context: DecisionAuthContext
  }) => Promise<string> | string
}

export type OtpBeginValidatedInput = {
  readonly subject: string
  readonly locale?: string
  readonly publicData?: PublicData
  readonly lookup: IdentityLookup
}

export type OtpCompleteValidatedInput = {
  readonly code: RawSecretValue<string>
  readonly publicData?: PublicData
}

export type OtpMethod = {
  readonly methodId: string
  readonly methodKind: 'otp'
  readonly operations: {
    readonly begin: MethodBeginOperation<OtpBeginValidatedInput>
    readonly complete: MethodCompleteOperation<OtpCompleteValidatedInput>
  }
}
