# @authmodules/delivery-email-smtp

Template-first SMTP email delivery for AuthModules.

The package adapts delivery messages to an injected SMTP-compatible client. It deliberately does not choose an SMTP library, connection pool, template engine, or provider SDK.

## Installation

GitHub Packages requires an authenticated npm client, including for public packages. Configure the scope without committing a token:

```ini
@authmodules:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a classic personal access token with `read:packages` locally, or the repository `GITHUB_TOKEN` in GitHub Actions.

```sh
npm install @authmodules/delivery-email-smtp @authmodules/contracts
```

## Usage

```ts
import { createSmtpDeliveryTransport } from '@authmodules/delivery-email-smtp'

const transport = createSmtpDeliveryTransport({
  now: () => applicationClock.now(),
  from: 'no-reply@example.com',
  render({ message, effectiveLocale }) {
    const code = message.data?.code
    if (!code || typeof code !== 'object' || typeof code.reveal !== 'function') {
      throw new TypeError('OTP code is missing')
    }
    return {
      subject: 'Your sign-in code',
      text: `Code: ${code.reveal()}`,
      headers: { 'X-Template-Locale': effectiveLocale ?? 'en' }
    }
  },
  client: {
    async sendMail(message) {
      return smtpClient.sendMail(message)
    }
  }
})
```

`client.sendMail` receives validated `from`, `to`, `subject`, `text`, `html`, `replyTo`, and custom headers. It may return a provider message identifier and acceptance time.

The optional `now` provider rechecks a delivery deadline immediately before contacting the SMTP client and records a safe local completion time. Inject the same clock used by the worker or application when using a virtual or deterministic clock; otherwise the adapter uses the system clock.

## Boundary guarantees

- Rendering happens only at the final delivery boundary where raw template secrets are needed.
- The context is privacy-narrowed before reaching the renderer or sender resolver.
- The sender resolver receives addressing and public template metadata, never `message.data`.
- Sender, recipient, subject, reply-to, and custom headers reject control-character injection; address-list separators are not accepted.
- Cyclic and excessively large delivery data is rejected before rendering.
- `redactDeliveryMessage` creates a log-safe representation without revealing secrets.

The logical idempotency key is forwarded to `client.sendMail`. Generic SMTP has no durable deduplication protocol, so this adapter provides at-least-once semantics and duplicates remain possible after an ambiguous provider result. Use a provider-specific client or adapter with durable idempotency when duplicates are unacceptable.

Configure SMTP authentication, TLS verification, retries, timeouts, pooling, and provider observability on the injected client.

## Requirements

- Node.js 24 or newer
- Native ESM
- An SMTP client with a `sendMail` method

## Development

```sh
npm run check
```

## License

MIT
