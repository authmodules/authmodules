import type { AuthStore } from '@authmodules/contracts/store'
import type { TransactionRunner } from '@authmodules/contracts/transaction'
import { createEmptyState, type MemoryState } from './state.ts'
import { createMemoryAccountsStore } from './accounts.ts'
import { createMemoryIdentitiesStore } from './identities.ts'
import { createMemoryCredentialsStore } from './credentials.ts'
import { createMemorySessionsStore } from './sessions.ts'
import { createMemoryChallengesStore } from './challenges.ts'
import { createMemoryTransaction } from './transaction.ts'

export type MemoryAuthStore = AuthStore & {
  readonly __unsafeState: MemoryState
}

export function createMemoryAuthStore(): MemoryAuthStore

export function createMemoryAuthStore(): MemoryAuthStore {
  const state = createEmptyState()
  return createMemoryAuthStoreForState(state, createMemoryTransaction(state))
}

export function createMemoryAuthStoreForState(
  state: MemoryState,
  transaction: TransactionRunner
): MemoryAuthStore {
  const store: MemoryAuthStore = {
    durable: {
      accounts: createMemoryAccountsStore(state),
      identities: createMemoryIdentitiesStore(state),
      credentials: createMemoryCredentialsStore(state)
    },
    session: { sessions: createMemorySessionsStore(state) },
    ephemeral: { challenges: createMemoryChallengesStore(state) },
    transaction,
    __unsafeState: state
  }

  return store
}
