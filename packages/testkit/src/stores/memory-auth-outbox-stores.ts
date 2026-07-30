import {
  createEmptyMemoryOutboxState,
  createMemoryOutboxStoreForState,
  type MemoryOutboxStore
} from './memory-outbox-store.ts'
import {
  createMemoryAuthStoreForState,
  type MemoryAuthStore
} from './memory-auth-store.ts'
import { createEmptyState } from './state.ts'
import { createMemoryTransaction } from './transaction.ts'

export type MemoryAuthOutboxStores = {
  readonly auth: MemoryAuthStore
  readonly outbox: MemoryOutboxStore
}

export function createMemoryAuthOutboxStores(): MemoryAuthOutboxStores {
  const authState = createEmptyState()
  const outboxState = createEmptyMemoryOutboxState()
  const transaction = createMemoryTransaction(authState, outboxState)
  return {
    auth: createMemoryAuthStoreForState(authState, transaction),
    outbox: createMemoryOutboxStoreForState(outboxState)
  }
}
