# @authmodules/outbox-worker

Lease-based delivery worker for AuthModules outbox records.

The worker claims pending messages, verifies leases, unseals secret-bearing fields only at the transport boundary, and marks each message dispatched or failed.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/outbox-worker @authmodules/contracts
```

## Usage

```ts
import { createOutboxWorker } from '@authmodules/outbox-worker'

const worker = createOutboxWorker({
  store: outboxStore,
  transport,
  sealer,
  workerId: process.env.INSTANCE_ID ?? 'worker-1',
  leaseSeconds: 30,
  limit: 50,
  retryDelaySeconds: 60
})

const result = await worker.runOnce({ now: new Date() })
```

Call `runOnce` from a scheduler or bounded application loop. It processes up to the configured limit and returns claimed, dispatched, and failed counts. Each message is claimed immediately before its sequential processing begins, so a slow delivery cannot expire leases for an already-claimed tail.

## Operational guarantees

- A worker may acknowledge only a message leased to its configured `workerId`.
- Expired leases and malformed store records are rejected.
- The worker renews the lease before secret unsealing and again before provider delivery.
- Message expiry and lease validity are rechecked after each renewal and immediately before delivery.
- Successful delivery is acknowledged using the worker's local completion time. A provider timestamp cannot shorten or extend a lease, while a send that locally outlives its lease returns a lease conflict and can be retried with the same idempotency key.
- Persisted raw or protected secrets are never accepted.
- Sealed values are unsealed immediately before transport delivery.
- Context is privacy-narrowed again even if a store returns extra fields.
- Cyclic and excessively large persisted data is rejected without delivery.

The `OutboxWorkerStore` implementation owns concurrency control, lease renewal, retry scheduling, terminal failure retention, and bounded cleanup. Reclaiming an abandoned lease consumes an attempt and dead-letters a record at `maxAttempts`. Run multiple workers only when the store provides atomic claim semantics.

Processing is at least once. A process or lease failure after the provider accepts a message but before `markDispatched` succeeds can cause a retry. The worker reuses the stable logical key; exactly-once behavior requires durable deduplication in the transport or provider.

## Requirements

- Node.js 24.11.0 or newer within Node.js 24
- Native ESM
- A durable `OutboxWorkerStore`, `DeliveryTransport`, and matching `SecretSealer`

## Development

```sh
npm run check
```

## License

MIT
