# @authmodules/store-postgres

Transactional PostgreSQL storage for AuthModules.

The package implements accounts, identities, credentials, sessions, challenges, a transactional delivery outbox, optimistic updates, cleanup, tenant isolation, and transaction participation without introducing an ORM.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/store-postgres @authmodules/contracts pg
```

## Usage

```ts
import { Pool } from 'pg'
import {
  createPostgresAuthStore,
  installPostgresSchema
} from '@authmodules/store-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const client = {
  query(sql, params) {
    return pool.query(sql, params)
  },
  async transaction(run) {
    const connection = await pool.connect()
    try {
      await connection.query('begin')
      const result = await run(connection)
      await connection.query('commit')
      return result
    } catch (error) {
      await connection.query('rollback')
      throw error
    } finally {
      connection.release()
    }
  }
}

await installPostgresSchema(client)
const store = createPostgresAuthStore({ client })
```

Use migrations under application release control in production. `installPostgresSchema` is convenient for initial setup and tests; `postgresSchemaSql` is exported for migration tooling.

For an auth store and delivery outbox sharing the same transaction identity, use `createPostgresAuthOutboxStores({ client })`. Request the scopes before the callback starts:

```ts
await stores.auth.transaction.run(
  { requiredScopes: ['accounts', 'outbox'] },
  async (tx) => {
    // Auth and outbox calls must both receive this callback-lifetime context.
  }
)
```

Unsupported scopes fail before the callback. A store operation also rejects a context that does not declare its own scope.

## Data guarantees

- Every key and relation includes `tenant_id`.
- Credential rows are constrained to the same account, identity, method identifier, and method kind.
- Session token identity uses scheme, key identifier, and verifier value; diagnostic metadata does not affect lookup.
- Challenge attempts and status changes use optimistic versions and terminal-state guards.
- Cleanup uses bounded batches and row locking suitable for concurrent workers.
- Outbox batch enqueue is one SQL statement, required messages have stable idempotency keys, abandoned leases consume an attempt, and terminal cleanup is bounded.
- PostgreSQL uniqueness and serialization failures are mapped to stable store failures.

A transaction-capable client is required for atomic authentication flows. Configure pool limits, statement timeouts, TLS, backups, monitoring, and migrations in the host application.

## Requirements

- Node.js 24 or newer
- Native ESM
- PostgreSQL 18 or newer; CI and release verification use `postgres:18-alpine`

## Development

```sh
npm run check
AUTHMODULES_POSTGRES_URL=postgres://... npm run test:integration
```

## License

MIT
