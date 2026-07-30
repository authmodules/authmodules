# @authmodules/effects-outbox

Transactional outbox dispatcher for reliable AuthModules delivery side effects.

The dispatcher seals raw delivery secrets, converts messages to persistence-safe records, and enqueues them through an injected `OutboxEnqueueStore` instead of sending them inline.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/effects-outbox @authmodules/contracts
```

## Usage

```ts
import { createOutboxEffectsDispatcher } from '@authmodules/effects-outbox'

const effects = createOutboxEffectsDispatcher({
  store: outboxStore,
  sealer,
  maxAttempts: 10,
  idGenerator() {
    return crypto.randomUUID()
  }
})
```

Pass the returned dispatcher to `createAuth({ effects })`. It declares the `outbox` transaction scope, so core requests that scope and enqueueing uses the same transaction boundary as auth-state writes.
The ID generator receives only tenant, time, index, dispatch policy, type, and
optional idempotency key. Recipient and delivery payload data never cross that
callback boundary.

By default, deadline checks advance the request timestamp by local elapsed time
while sealing and enqueueing run. A host that uses a custom or simulated clock
must pass `now: () => clock.now()` so the dispatcher and worker share the same
time source. The supplied time must never move backwards.

## Persistence guarantees

- Raw delivery secrets are sealed before `OutboxEnqueueStore.enqueueBatch` is called.
- Each policy partition is persisted atomically and in its original relative order.
- Required effects join the auth transaction; best-effort effects are normally enqueued after commit and cannot roll back accepted required effects.
- Required effects must carry stable idempotency keys.
- Reusing a key for the same logical delivery is safe even when `idGenerator`
  returns a new identifier. A replay whose immutable policy, context, expiry,
  retry limit, recipient, template, metadata, or secret payload differs fails
  closed instead of acknowledging the older record.
- A terminal `dead` record cannot acknowledge a replay because it will not be
  delivered.
- Raw and protected values are rejected by `toPersistableDeliveryMessage`.
- Seal purpose is bound to tenant and message identifiers.
- Expired effects are rejected before enqueue.
- Expiry is rechecked after secret sealing and immediately before each enqueue batch.
- Context is reduced to tenant, request, locale, and safe metadata.
- Cyclic or excessively large data is rejected before recursive sealing.

This package does not include a production outbox store. The host application must provide a durable implementation with atomic batch enqueueing, leasing, retry state, retention cleanup, and enqueue idempotency. The memory store in `@authmodules/testkit` is for tests only.

The outbox provides durable at-least-once processing, not exactly-once external delivery. The worker forwards the stable logical key, but duplicate suppression depends on a transport or provider with durable deduplication.

Use `@authmodules/outbox-worker` to claim and deliver persisted messages.

## Requirements

- Node.js 24 or newer
- Native ESM
- An `OutboxEnqueueStore` and `SecretSealer`

## Development

```sh
npm run check
```

## License

MIT
