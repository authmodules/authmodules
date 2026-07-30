import type { PasswordHasher } from '@authmodules/contracts/crypto'
import type {
  MethodAuthenticateOperation,
  MethodEnrollOperation
} from '@authmodules/contracts/method'
import type { IdentityLookup, PublicData } from '@authmodules/contracts/primitives'
import type { RawSecretValue } from '@authmodules/contracts/security'

export type PasswordMethodInput = {
  readonly subject: string
  readonly password: RawSecretValue<string>
  readonly display?: string
  readonly publicData?: PublicData
}

export type PasswordMethodOptions = {
  readonly methodId?: string
  readonly subjectKind?: string
  readonly minPasswordLength?: number
  readonly maxPasswordLength?: number
  readonly passwordHasher: PasswordHasher
}

export type PasswordValidatedInput = {
  readonly subject: string
  readonly password: RawSecretValue<string>
  readonly lookup: IdentityLookup
  readonly publicData?: PublicData
}

export type PasswordMethod = {
  readonly methodId: string
  readonly methodKind: 'password'
  readonly operations: {
    readonly enroll: MethodEnrollOperation<PasswordValidatedInput>
    readonly authenticate: MethodAuthenticateOperation<PasswordValidatedInput>
  }
}
