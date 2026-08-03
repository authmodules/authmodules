# @authmodules/effects-sync-delivery

Synchronous delivery side-effect dispatcher for AuthModules.

Use this package when authentication should call a `DeliveryTransport` before the operation returns.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/effects-sync-delivery @authmodules/contracts
```

## Usage

```ts
import { createSyncDeliveryEffects } from '@authmodules/effects-sync-delivery'

const effects = createSyncDeliveryEffects({ transport })
```

Pass the returned dispatcher to `createAuth({ effects })`.

## Delivery semantics

- A required delivery failure fails the side-effect dispatch and therefore the enclosing authentication operation.
- A best-effort failure is returned in `failed[]` while the dispatch result remains successful.
- Expired effects are never sent.
- Expiry is rechecked immediately before every transport call.
- The complete batch is validated before the first transport call.
- Malformed transport results and thrown transport errors are mapped to component failures.
- Only tenant, request, locale, and safe metadata context may cross the delivery boundary.

Core rejects a required synchronous effect when the same operation writes auth state. An external provider call cannot commit atomically with the database; use the transactional outbox dispatcher for that case. Required synchronous delivery remains suitable for flows without auth-state mutation. The stable idempotency key is forwarded to the transport, but duplicate suppression exists only when the transport or provider durably implements it.

Batch prevalidation prevents partial delivery caused by a malformed or already expired later item. Time can advance during dispatch, so a later effect may expire after an earlier one was sent. A provider failure can also leave an earlier effect delivered. Every required effect must therefore carry the stable logical key required by the contract, and hosts that cannot tolerate duplicates must use a provider-specific deduplicating adapter.

Synchronous delivery does not provide durable retry or crash recovery. Choose `@authmodules/effects-outbox` with `@authmodules/outbox-worker` when the delivery request must survive process failure.

## Requirements

- Node.js 24.11.0 or newer within Node.js 24
- Native ESM
- A `DeliveryTransport` implementation

## Development

```sh
npm run check
```

## License

MIT
