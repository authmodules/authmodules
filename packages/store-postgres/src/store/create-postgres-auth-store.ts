import type { AuthStore } from '@authmodules/contracts/store'
import type { TransactionContext, TransactionRunner, TransactionScope } from '@authmodules/contracts/transaction'
import type {
  PostgresAuthOutboxStores,
  PostgresAuthStoreOptions,
  PostgresClient
} from '../database/types.ts'
import { defaultSecretFactory } from '../serialization/secrets.ts'
import { createPostgresAccountsStore } from './accounts.ts'
import { createPostgresIdentitiesStore } from './identities.ts'
import { createPostgresCredentialsStore } from './credentials.ts'
import { createPostgresSessionsStore } from './sessions.ts'
import { createPostgresChallengesStore } from './challenges.ts'
import { createPostgresTransaction } from './transaction.ts'
import { createPostgresOutboxStore } from './outbox.ts'

export function createPostgresAuthStore(options: PostgresAuthStoreOptions): AuthStore
export function createPostgresAuthStore(options?: PostgresAuthStoreOptions): AuthStore {
  assertPostgresStoreOptions(options)
  const context = createPostgresStoreContext(options)
  return createClientBackedPostgresStore(options, context)
}

export function createPostgresAuthOutboxStores(options: PostgresAuthStoreOptions): PostgresAuthOutboxStores {
  assertPostgresStoreOptions(options)
  const context = createPostgresStoreContext(options, [
    'accounts',
    'identities',
    'credentials',
    'sessions',
    'challenges',
    'outbox'
  ])
  return {
    auth: createClientBackedPostgresStore(options, context),
    outbox: createPostgresOutboxStore(
      (tx) => context.clientFor('outbox', tx),
      options.secretFactory ?? defaultSecretFactory
    )
  }
}

function assertPostgresStoreOptions(options: unknown): asserts options is PostgresAuthStoreOptions {
  if (!isRecord(options) || !isRecord(options.client) || typeof options.client.query !== 'function') {
    throw new TypeError('createPostgresAuthStore requires a PostgreSQL client')
  }
  if (options.client.transaction !== undefined && typeof options.client.transaction !== 'function') {
    throw new TypeError('PostgreSQL client.transaction must be a function')
  }
  if (options.secretFactory !== undefined && (
    !isRecord(options.secretFactory) ||
    typeof options.secretFactory.protectedValue !== 'function' ||
    typeof options.secretFactory.sealedValue !== 'function'
  )) {
    throw new TypeError('PostgreSQL secretFactory is invalid')
  }
}

type PostgresStoreContext = {
  readonly clientFor: (scope: TransactionScope, tx?: TransactionContext) => PostgresClient
  readonly transaction?: TransactionRunner
}

function createPostgresStoreContext(
  options: PostgresAuthStoreOptions,
  covers?: readonly TransactionScope[]
): PostgresStoreContext {
  const client = options.client
  const transactionClients = new WeakMap<TransactionContext, PostgresClient>()

  function clientFor(scope: TransactionScope, tx?: TransactionContext): PostgresClient {
    if (!tx) return client
    const transactionClient = transactionClients.get(tx)
    if (!transactionClient || !tx.covers.includes(scope)) {
      throw new TypeError('Transaction context does not belong to this PostgreSQL store')
    }
    return transactionClient
  }

  return {
    clientFor,
    transaction: typeof client.transaction === 'function'
      ? createPostgresTransaction(client, transactionClients, covers)
      : undefined
  }
}

function createClientBackedPostgresStore(
  options: PostgresAuthStoreOptions,
  context: PostgresStoreContext
): AuthStore {
  const secretFactory = options.secretFactory ?? defaultSecretFactory
  const clientFor = context.clientFor

  const store: AuthStore = {
    durable: {
      accounts: createPostgresAccountsStore((tx) => clientFor('accounts', tx)),
      identities: createPostgresIdentitiesStore((tx) => clientFor('identities', tx)),
      credentials: createPostgresCredentialsStore((tx) => clientFor('credentials', tx), secretFactory)
    },
    session: { sessions: createPostgresSessionsStore((tx) => clientFor('sessions', tx), secretFactory) },
    ephemeral: { challenges: createPostgresChallengesStore((tx) => clientFor('challenges', tx), secretFactory) }
  }

  return context.transaction ? { ...store, transaction: context.transaction } : store
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
