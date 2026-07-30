import type { OutboxStore } from '@authmodules/contracts/extensions'
import type { SecretFactory } from '@authmodules/contracts/security'
import type { AuthStore } from '@authmodules/contracts/store'
import type { TransactionContext } from '@authmodules/contracts/transaction'

export type PostgresClient = {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>
  transaction?<T>(fn: (client: PostgresClient) => Promise<T>): Promise<T>
}

export type PostgresAuthStoreOptions = {
  readonly client: PostgresClient
  readonly secretFactory?: Pick<SecretFactory, 'protectedValue' | 'sealedValue'>
}

export type PostgresClientFor = (tx?: TransactionContext) => PostgresClient

export type PostgresAuthOutboxStores = {
  readonly auth: AuthStore
  readonly outbox: OutboxStore
}
