import type {
  Auth,
  AuthGuard,
  AuthStore,
  CreateSessionRequest,
  DispatchContext,
  IssuedTokenView,
  RecordFailedAttemptResult,
  TokenFormat,
  TokenIdentifyResult,
  TokenIssueResult,
  TransactionRunner
} from '@authmodules/contracts'
import type { SecretHttpValue } from '@authmodules/contracts/carrier'
import type { OutboxStore } from '@authmodules/contracts/extensions'
import type { RawSecretValue } from '@authmodules/contracts/security'

type Assert<T extends true> = T

type _RootExports = [
  Auth,
  AuthGuard,
  AuthStore,
  CreateSessionRequest,
  DispatchContext,
  IssuedTokenView,
  RecordFailedAttemptResult,
  TokenFormat,
  TokenIssueResult,
  TransactionRunner
]

type _TokenIdentifyAllowsNormalNull = Assert<null extends TokenIdentifyResult ? true : false>
type _HeaderValuesAllowPartsBasedSecrets = Assert<RawSecretValue<string> extends SecretHttpValue['parts'][number] ? true : false>
type _ExtensionsExposeOutbox = Assert<OutboxStore extends object ? true : false>
