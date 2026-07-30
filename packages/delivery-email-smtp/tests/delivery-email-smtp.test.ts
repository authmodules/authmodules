import test from 'node:test'
import assert from 'node:assert/strict'
import { createSmtpDeliveryTransport, redactDeliveryMessage } from '../src/index.ts'

test('redacts shallow secret values and rejects nested secrets', () => {
  let reveals = 0
  const code = secret('123456', '[CODE]')
  code.reveal = () => {
    reveals += 1
    throw new Error('redaction must not reveal')
  }
  const redacted = redactDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: {
      code,
      nested: {
        label: 'safe'
      }
    }
  })

  assert.deepEqual(redacted.data, {
    code: '[REDACTED]',
    nested: {
      label: 'safe'
    }
  })
  assert.equal(reveals, 0)
  assert.deepEqual(redactDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: {
      profile: { redacted: 'public-label', id: 7 },
      unsafeSecret: secret('same-value', 'same-value')
    }
  }).data, {
    profile: { redacted: 'public-label', id: 7 },
    unsafeSecret: '[REDACTED]'
  })
  assert.throws(() => redactDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: { nested: { token: secret('raw-token', '[TOKEN]') } }
  }), /invalid/)
  assert.throws(() => redactDeliveryMessage({
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    unexpectedSecret: secret('must-not-survive', '[SECRET]')
  }), /invalid/)
})

test('transport renders secret-bearing templates only at the final boundary and calls the SMTP client', async () => {
  const acceptedAt = new Date('2026-01-01T00:00:00.000Z')
  let captured
  const transport = createSmtpDeliveryTransport({
    now: () => acceptedAt,
    from: 'no-reply@example.test',
    render(input) {
      assert.equal(input.effectiveLocale, 'fr')
      assert.equal(JSON.stringify(input.message.data.code), '"[REDACTED]"')
      return {
        subject: 'Your sign-in code',
        text: `Code: ${input.message.data.code.reveal()}`
      }
    },
    client: {
      async sendMail(input) {
        captured = input
        return { providerMessageId: 'smtp_1' }
      }
    }
  })

  const result = await transport.send({
    context: {
      tenantId: 'tenant_1',
      locale: 'en'
    },
    idempotencyKey: 'delivery_1',
    now: new Date('2025-12-31T23:59:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp',
      locale: 'fr',
      data: {
        code: secret('123456', '123')
      }
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.providerMessageId, 'smtp_1')
  assert.equal(result.value.acceptedAt.toISOString(), acceptedAt.toISOString())
  assert.deepEqual(captured, {
    from: 'no-reply@example.test',
    to: 'user@example.test',
    subject: 'Your sign-in code',
    text: 'Code: 123456',
    html: undefined,
    replyTo: undefined,
    headers: undefined,
    idempotencyKey: 'delivery_1'
  })
})

test('dynamic sender resolution cannot access template secret data', async () => {
  let senderInput
  const transport = createSmtpDeliveryTransport({
    from(input) {
      senderInput = input
      return 'no-reply@example.test'
    },
    render: () => ({ subject: 'Subject', text: 'Body' }),
    client: {
      async sendMail() {
        return undefined
      }
    }
  })

  const result = await transport.send({
    context: { tenantId: 'tenant_1', locale: 'en' },
    idempotencyKey: 'delivery_sender_boundary',
    now: new Date('2026-01-01T00:00:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp',
      data: { code: secret('123456', '[CODE]') },
      metadata: { senderProfile: 'transactional' }
    }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(senderInput, {
    context: { tenantId: 'tenant_1', locale: 'en' },
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    metadata: { senderProfile: 'transactional' },
    idempotencyKey: 'delivery_sender_boundary',
    effectiveLocale: 'en',
    now: new Date('2026-01-01T00:00:00.000Z')
  })
  assert.equal('message' in senderInput, false)
  assert.equal(JSON.stringify(senderInput).includes('123456'), false)
})

test('transport reads stateful SMTP result fields exactly once and owns the accepted timestamp', async () => {
  let providerReads = 0
  let acceptedReads = 0
  const acceptedAt = new Date('2026-01-01T00:00:00.000Z')
  const transport = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render: () => ({ subject: 'Subject', text: 'Body' }),
    client: {
      async sendMail() {
        return {
          get providerMessageId() {
            providerReads += 1
            return providerReads === 1 ? 'smtp_stateful' : ''
          },
          get acceptedAt() {
            acceptedReads += 1
            return acceptedReads === 1 ? acceptedAt : new Date('invalid')
          }
        }
      }
    }
  })

  const result = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2025-12-31T23:59:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'stateful-result'
    }
  })
  acceptedAt.setUTCFullYear(2030)

  assert.equal(result.ok, true)
  assert.equal(result.value.providerMessageId, 'smtp_stateful')
  assert.equal(result.value.acceptedAt.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(providerReads, 1)
  assert.equal(acceptedReads, 1)
})

test('transport snapshots a stateful message property before validation', async () => {
  let recipient
  let messageReads = 0
  const transport = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render: () => ({ subject: 'Safe subject', text: 'Safe body' }),
    client: {
      async sendMail(input) {
        recipient = input.to
        return { acceptedAt: new Date('2026-01-01T00:00:00.000Z') }
      }
    }
  })
  const validMessage = {
    to: { channel: 'email', target: 'victim@example.test' },
    templateId: 'stateful-message'
  }
  const replacementMessage = {
    to: { channel: 'email', target: 'attacker@example.test' },
    templateId: 'stateful-message'
  }
  const input = Object.defineProperty({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z')
  }, 'message', {
    enumerable: true,
    get() {
      messageReads += 1
      return messageReads === 1 ? validMessage : replacementMessage
    }
  }) as unknown as Parameters<typeof transport.send>[0]

  const result = await transport.send(input)

  assert.equal(result.ok, true)
  assert.equal(messageReads, 1)
  assert.equal(recipient, 'victim@example.test')
})

test('renderer mutations cannot redirect the validated recipient', async () => {
  let recipient
  const transport = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render(input) {
      Object.assign(input.message.to, { target: 'attacker@example.test' })
      return { subject: 'Safe subject', text: 'Safe body' }
    },
    client: {
      async sendMail(input) {
        recipient = input.to
        return { acceptedAt: new Date('2026-01-01T00:00:00.000Z') }
      }
    }
  })

  const result = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    message: {
      to: { channel: 'email', target: 'victim@example.test' },
      templateId: 'notification'
    }
  })

  assert.equal(result.ok, true)
  assert.equal(recipient, 'victim@example.test')
})

test('transport privacy-narrows context before rendering', async () => {
  let renderedContext
  const transport = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render(input) {
      renderedContext = input.context
      return { subject: 'Code', text: 'safe' }
    },
    client: { async sendMail() {} }
  })

  const result = await transport.send({
    context: {
      tenantId: 'tenant_1',
      requestId: 'request_1',
      actor: { type: 'account', accountId: 'must-not-cross-boundary' },
      ip: '127.0.0.1',
      policyInput: { role: 'must-not-cross-boundary' },
      metadata: { labels: ['safe', 1, true, null] }
    },
    now: new Date('2026-01-01T00:00:00.000Z'),
    message: { to: { channel: 'email', target: 'user@example.test' }, templateId: 'otp' }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(renderedContext, {
    tenantId: 'tenant_1',
    requestId: 'request_1',
    metadata: { labels: ['safe', 1, true, null] }
  })
})

test('transport rejects header injection before calling the SMTP client', async () => {
  let called = false
  const transport = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render() {
      return { subject: 'Code\r\nBcc: attacker@example.test', text: 'safe' }
    },
    client: {
      async sendMail() {
        called = true
      }
    }
  })

  const result = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp'
    }
  })

  assert.equal(result.ok, false)
  assert.equal(called, false)
})

test('transport snapshots renderer output before validation and SMTP delivery', async () => {
  let subjectReads = 0
  let captured
  const transport = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render() {
      return {
        get subject() {
          subjectReads += 1
          return subjectReads === 1 ? 'Safe subject' : 'Unsafe\r\nBcc: attacker@example.test'
        },
        text: 'safe'
      }
    },
    client: {
      async sendMail(input) {
        captured = input
      }
    }
  })

  const result = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp'
    }
  })

  assert.equal(result.ok, true)
  assert.equal(subjectReads, 1)
  assert.equal(captured.subject, 'Safe subject')
})

test('transport rejects invalid custom headers without retrying a resolved provider receipt', async () => {
  let called = 0
  const invalidHeader = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render() {
      return { subject: 'Code', text: 'safe', headers: { 'X-Safe: Bcc': 'attacker@example.test' } }
    },
    client: {
      async sendMail() {
        called += 1
      }
    }
  })
  const input = {
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp'
    }
  }
  const rejectedHeader = await invalidHeader.send(input)
  assert.equal(rejectedHeader.ok, false)
  assert.equal(called, 0)

  const reservedHeader = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render() {
      return { subject: 'Code', text: 'safe', headers: { Bcc: 'attacker@example.test' } }
    },
    client: {
      async sendMail() {
        called += 1
      }
    }
  })
  assert.equal((await reservedHeader.send(input)).ok, false)
  assert.equal(called, 0)

  const invalidTimestamp = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render() {
      return { subject: 'Code', text: 'safe' }
    },
    client: {
      async sendMail() {
        called += 1
        return {
          providerMessageId: 'unsafe\u0000id',
          acceptedAt: new Date('invalid')
        }
      }
    }
  })
  const acceptedTimestamp = await invalidTimestamp.send(input)
  assert.equal(acceptedTimestamp.ok, true)
  assert.equal(acceptedTimestamp.value.providerMessageId, undefined)
  assert.equal(Number.isFinite(acceptedTimestamp.value.acceptedAt.getTime()), true)
  assert.equal(called, 1)
})

test('transport rechecks expiry immediately before contacting the provider', async () => {
  const expiresAt = new Date('2026-01-01T00:00:01.000Z')
  let providerCalls = 0
  const transport = createSmtpDeliveryTransport({
    now: () => expiresAt,
    from: async () => 'no-reply@example.test',
    render: async () => ({ subject: 'Code', text: 'safe' }),
    client: {
      async sendMail() {
        providerCalls += 1
      }
    }
  })

  const result = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt,
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp'
    }
  })

  assert.equal(result.ok, false)
  assert.equal(providerCalls, 0)
})

test('transport records completion time by default and rejects ambiguous recipients', async () => {
  let called = 0
  const transport = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render() {
      return { subject: 'Code', text: 'safe' }
    },
    client: {
      async sendMail() {
        called += 1
      }
    }
  })
  const before = Date.now()
  const accepted = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2020-01-01T00:00:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp'
    }
  })
  const after = Date.now()

  assert.equal(accepted.ok, true)
  assert.ok(accepted.value.acceptedAt.getTime() >= before)
  assert.ok(accepted.value.acceptedAt.getTime() <= after)

  const rejected = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date(),
    message: {
      to: { channel: 'email', target: 'user@example.test, attacker@example.test' },
      templateId: 'otp'
    }
  })
  assert.equal(rejected.ok, false)
  assert.equal(called, 1)
})

test('transport and redaction reject cyclic delivery data before recursion', async () => {
  let called = false
  const cyclic = {}
  cyclic.self = cyclic
  const message = {
    to: { channel: 'email', target: 'user@example.test' },
    templateId: 'otp',
    data: cyclic
  }
  const transport = createSmtpDeliveryTransport({
    from: 'no-reply@example.test',
    render() { return { subject: 'Code', text: 'safe' } },
    client: { async sendMail() { called = true } }
  })

  const result = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    message
  })

  assert.equal(result.ok, false)
  assert.equal(called, false)
  assert.throws(() => redactDeliveryMessage(message), /invalid/)

  const disguised = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp',
      data: {
        verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
      }
    }
  })
  const disguisedMetadata = await transport.send({
    context: { tenantId: 'tenant_1' },
    now: new Date('2026-01-01T00:00:00.000Z'),
    message: {
      to: { channel: 'email', target: 'user@example.test' },
      templateId: 'otp',
      metadata: {
        verifier: { type: 'protected-value', scheme: 'test.v1', value: 'must-not-cross' }
      }
    }
  })

  assert.equal(disguised.ok, false)
  assert.equal(disguisedMetadata.ok, false)
  assert.equal(called, false)
})

function secret(value, redacted) {
  return {
    type: 'raw-secret',
    redacted,
    reveal() {
      return value
    },
    toJSON() {
      return redacted
    }
  }
}
