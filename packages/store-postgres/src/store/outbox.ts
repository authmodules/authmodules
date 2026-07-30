import type { LeasedOutboxMessage, OutboxMessage, OutboxStore } from '@authmodules/contracts/extensions'
import type { SecretFactory } from '@authmodules/contracts/security'
import type { PostgresClientFor } from '../database/types.ts'
import { queryCount } from '../database/query.ts'
import { date } from '../shared/date.ts'
import { persistedJson, persistedPlainJson } from '../serialization/json.ts'
import { reviveSecrets } from '../serialization/secrets.ts'
import { storeErr } from '../shared/result.ts'
import {
  isOutboxClaimInput,
  isOutboxCleanupTerminalInput,
  isOutboxMarkDispatchedInput,
  isOutboxMarkFailedInput,
  isOutboxRenewLeaseInput,
  isPersistableOutboxMessage
} from './outbox-validation.ts'

type SecretReviver = Pick<SecretFactory, 'protectedValue' | 'sealedValue'>
const maxBatchPayloadCharacters = 10_000_000

export function createPostgresOutboxStore(
  clientFor: PostgresClientFor,
  secretFactory: SecretReviver
): OutboxStore {
  async function enqueueBatch(
    input: Parameters<OutboxStore['enqueueBatch']>[0],
    tx?: Parameters<OutboxStore['enqueueBatch']>[1]
  ): ReturnType<OutboxStore['enqueueBatch']> {
    if (!Array.isArray(input?.messages)
      || input.messages.length > 1000
      || !input.messages.every((message) => isPersistableOutboxMessage(message, true))) {
      return storeErr('OUTBOX_ENQUEUE_FAILED')
    }
    if (input.messages.length === 0) return { ok: true, value: [] }
    const messageIds = new Set<string>()
    const idempotencyKeys = new Set<string>()
    const parameters: unknown[] = []
    const values: string[] = []
    let payloadCharacters = 0

    for (const [index, message] of input.messages.entries()) {
      const messageKey = `${message.tenantId}\u0000${message.messageId}`
      if (messageIds.has(messageKey)) return storeErr('OUTBOX_ENQUEUE_FAILED')
      messageIds.add(messageKey)
      if (message.idempotencyKey !== undefined) {
        const idempotencyKey = `${message.tenantId}\u0000${message.idempotencyKey}`
        if (idempotencyKeys.has(idempotencyKey)) return storeErr('OUTBOX_ENQUEUE_FAILED')
        idempotencyKeys.add(idempotencyKey)
      }
      const context = persistedPlainJson(message.context)
      if (!context.ok || typeof context.value !== 'string') return storeErr('OUTBOX_ENQUEUE_FAILED')
      const persistedMessage = persistedJson(message.message)
      if (!persistedMessage.ok) return storeErr('OUTBOX_ENQUEUE_FAILED')
      payloadCharacters += context.value.length + persistedMessage.value.length
      if (payloadCharacters > maxBatchPayloadCharacters) return storeErr('OUTBOX_ENQUEUE_FAILED')
      const offset = index * 17
      values.push(`(${Array.from({ length: 17 }, (_, parameter) => `$${offset + parameter + 1}`).join(', ')})`)
      parameters.push(
        index,
        message.tenantId,
        message.messageId,
        context.value,
        message.secretPurpose,
        message.type,
        persistedMessage.value,
        message.dispatchPolicy,
        message.status,
        message.attempts,
        message.maxAttempts,
        message.lastFailureReason,
        message.idempotencyKey,
        message.expiresAt,
        message.availableAt,
        message.createdAt,
        message.updatedAt
      )
    }

    let inserted: unknown
    try {
      inserted = await clientFor(tx).query(`with input (
          ordinal, tenant_id, message_id, context, secret_purpose, type, message, dispatch_policy, status,
          attempts, max_attempts, last_failure_reason, idempotency_key, expires_at, available_at, created_at, updated_at
        ) as (values ${values.join(', ')}),
        upserted as (
          insert into authmodules_outbox
            (tenant_id, message_id, context, secret_purpose, type, message, dispatch_policy, status, attempts,
              max_attempts, last_failure_reason, idempotency_key, expires_at, available_at, created_at, updated_at)
          select tenant_id, message_id, context::jsonb, secret_purpose, type, message::jsonb, dispatch_policy,
            status, attempts::integer, max_attempts::integer, last_failure_reason, idempotency_key, expires_at::timestamptz,
            available_at::timestamptz, created_at::timestamptz, updated_at::timestamptz
          from input
          on conflict (tenant_id, idempotency_key) where idempotency_key is not null
            do update set idempotency_key = excluded.idempotency_key
          returning *
        )
        select upserted.*
        from input
        join upserted on upserted.tenant_id = input.tenant_id
          and (upserted.message_id = input.message_id
            or (input.idempotency_key is not null and upserted.idempotency_key = input.idempotency_key))
        order by input.ordinal::integer`, parameters)
    } catch {
      return storeErr('OUTBOX_ENQUEUE_FAILED')
    }
    if (!isRecord(inserted) || !Array.isArray(inserted.rows) || inserted.rows.length !== input.messages.length) {
      return storeErr('STORE_UNAVAILABLE')
    }
    try {
      return {
        ok: true,
        value: inserted.rows.map((row) => outboxFromRow(row, secretFactory))
      }
    } catch {
      return storeErr('STORE_UNAVAILABLE')
    }
  }

  return {
    async enqueue(input, tx) {
      if (!input || !('message' in input)) return storeErr('OUTBOX_ENQUEUE_FAILED')
      const result = await enqueueBatch({ messages: [input.message] }, tx)
      return result.ok ? { ok: true, value: result.value[0] } : result
    },
    enqueueBatch,

    async claimBatch(input) {
      if (!isOutboxClaimInput(input)) return storeErr('OUTBOX_LEASE_CONFLICT')
      const client = clientFor()
      const expired = await queryCount(client, `with expired as (
          select tenant_id, message_id
          from authmodules_outbox
          where status in ('pending', 'failed', 'claimed') and expires_at is not null and expires_at <= $1
            and ($2::text is null or tenant_id = $2)
          order by expires_at, tenant_id, message_id
          limit $3
          for update skip locked
        )
        update authmodules_outbox as outbox
        set status = 'dead', lease_id = null, worker_id = null, lease_until = null, updated_at = $1
        from expired
        where outbox.tenant_id = expired.tenant_id and outbox.message_id = expired.message_id`,
      [input.now, input.tenantId ?? null, input.limit])
      if (!expired.ok) return expired
      const reclaimed = await queryCount(client, `with abandoned as (
          select tenant_id, message_id
          from authmodules_outbox
          where status = 'claimed' and lease_until <= $1
            and ($2::text is null or tenant_id = $2)
          order by lease_until, tenant_id, message_id
          limit $3
          for update skip locked
        )
        update authmodules_outbox as outbox
        set attempts = attempts + 1,
          status = case when attempts + 1 >= max_attempts then 'dead' else 'failed' end,
          last_failure_reason = 'OUTBOX_LEASE_CONFLICT',
          available_at = $1,
          lease_id = null,
          worker_id = null,
          lease_until = null,
          updated_at = $1
        from abandoned
        where outbox.tenant_id = abandoned.tenant_id and outbox.message_id = abandoned.message_id`,
      [input.now, input.tenantId ?? null, input.limit])
      if (!reclaimed.ok) return reclaimed
      let claimed: unknown
      try {
        claimed = await client.query(`with candidates as (
          select tenant_id, message_id
          from authmodules_outbox
          where ($5::text is null or tenant_id = $5)
            and (expires_at is null or expires_at > $1)
            and available_at <= $1
            and attempts < max_attempts
            and status in ('pending', 'failed')
          order by available_at, created_at, message_id
          limit $2
          for update skip locked
        )
        update authmodules_outbox as outbox
        set status = 'claimed',
          worker_id = $3,
          lease_id = gen_random_uuid()::text,
          lease_until = $1 + ($4 * interval '1 second'),
          updated_at = $1
        from candidates
        where outbox.tenant_id = candidates.tenant_id and outbox.message_id = candidates.message_id
        returning outbox.*`, [input.now, input.limit, input.workerId, input.leaseSeconds, input.tenantId ?? null])
      } catch {
        return storeErr('STORE_UNAVAILABLE')
      }
      if (!isRecord(claimed) || !Array.isArray(claimed.rows)) return storeErr('STORE_UNAVAILABLE')
      try {
        return { ok: true, value: claimed.rows.map((row) => leasedOutboxFromRow(row, secretFactory)) }
      } catch {
        return storeErr('STORE_UNAVAILABLE')
      }
    },

    async renewLease(input) {
      if (!isOutboxRenewLeaseInput(input)) return storeErr('OUTBOX_LEASE_CONFLICT')
      let renewed: unknown
      try {
        renewed = await clientFor().query(`update authmodules_outbox
          set lease_until = $5 + ($6 * interval '1 second'), updated_at = $5
          where tenant_id = $1 and message_id = $2 and status = 'claimed'
            and worker_id = $3 and lease_id = $4 and lease_until > $5
          returning lease_id, worker_id, lease_until`, [
          input.tenantId,
          input.messageId,
          input.workerId,
          input.leaseId,
          input.now,
          input.leaseSeconds
        ])
      } catch {
        return storeErr('STORE_UNAVAILABLE')
      }
      if (!isRecord(renewed) || !Array.isArray(renewed.rows)) return storeErr('STORE_UNAVAILABLE')
      if (renewed.rows.length !== 1) return storeErr('OUTBOX_LEASE_CONFLICT')
      try {
        const row = record(renewed.rows[0])
        return {
          ok: true,
          value: {
            leaseId: text(row.lease_id),
            workerId: text(row.worker_id),
            leaseUntil: date(row.lease_until)
          }
        }
      } catch {
        return storeErr('STORE_UNAVAILABLE')
      }
    },

    async markDispatched(input) {
      if (!isOutboxMarkDispatchedInput(input)) return storeErr('OUTBOX_LEASE_CONFLICT')
      const updated = await queryCount(clientFor(), `update authmodules_outbox
        set status = 'dispatched', last_failure_reason = null,
          lease_id = null, worker_id = null, lease_until = null, updated_at = $5
        where tenant_id = $1 and message_id = $2 and status = 'claimed'
          and worker_id = $3 and lease_id = $4 and lease_until > $5`, [
        input.tenantId,
        input.messageId,
        input.workerId,
        input.leaseId,
        input.now
      ])
      if (!updated.ok) return updated
      return updated.value === 1 ? { ok: true, value: undefined } : storeErr('OUTBOX_LEASE_CONFLICT')
    },

    async markFailed(input) {
      if (!isOutboxMarkFailedInput(input)) return storeErr('OUTBOX_LEASE_CONFLICT')
      const updated = await queryCount(clientFor(), `update authmodules_outbox
        set attempts = attempts + 1,
          status = case when $6 or attempts + 1 >= max_attempts then 'dead' else 'failed' end,
          available_at = coalesce($7, $5),
          last_failure_reason = $8,
          lease_id = null,
          worker_id = null,
          lease_until = null,
          updated_at = $5
        where tenant_id = $1 and message_id = $2 and status = 'claimed'
          and worker_id = $3 and lease_id = $4 and lease_until > $5`, [
        input.tenantId,
        input.messageId,
        input.workerId,
        input.leaseId,
        input.now,
        input.terminal === true,
        input.retryAt,
        input.reason
      ])
      if (!updated.ok) return updated
      return updated.value === 1 ? { ok: true, value: undefined } : storeErr('OUTBOX_LEASE_CONFLICT')
    },

    async cleanupTerminal(input) {
      if (!isOutboxCleanupTerminalInput(input)) return storeErr('OUTBOX_LEASE_CONFLICT')
      return queryCount(clientFor(), `with terminal as (
          select tenant_id, message_id
          from authmodules_outbox
          where status = any($1::text[])
            and updated_at <= $2
            and ($3::text is null or tenant_id = $3)
          order by updated_at, tenant_id, message_id
          limit $4
          for update skip locked
        )
        delete from authmodules_outbox as outbox
        using terminal
        where outbox.tenant_id = terminal.tenant_id and outbox.message_id = terminal.message_id`, [
        input.statuses,
        input.before,
        input.tenantId ?? null,
        input.limit
      ])
    }
  }
}

function outboxFromRow(value: unknown, secretFactory: SecretReviver): OutboxMessage {
  const row = record(value)
  const persistedMessage = reviveSecrets(row.message, secretFactory)
  const message = {
    tenantId: text(row.tenant_id),
    messageId: text(row.message_id),
    context: row.context,
    secretPurpose: text(row.secret_purpose),
    type: oneOf(row.type, ['delivery']),
    message: persistedMessage,
    dispatchPolicy: oneOf(row.dispatch_policy, ['required', 'best-effort']),
    status: oneOf(row.status, ['pending', 'claimed', 'dispatched', 'failed', 'dead']),
    attempts: integer(row.attempts),
    maxAttempts: integer(row.max_attempts),
    lastFailureReason: optionalText(row.last_failure_reason),
    idempotencyKey: optionalText(row.idempotency_key),
    expiresAt: optionalDate(row.expires_at),
    availableAt: date(row.available_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at)
  }
  if (!isPersistableOutboxMessage(message, false)) {
    throw new TypeError('PostgreSQL returned an invalid outbox row')
  }
  return message
}

function leasedOutboxFromRow(value: unknown, secretFactory: SecretReviver): LeasedOutboxMessage {
  const row = record(value)
  const message = outboxFromRow(row, secretFactory)
  if (message.status !== 'claimed') throw new TypeError('PostgreSQL returned a non-claimed outbox row')
  return {
    ...message,
    lease: {
      leaseId: text(row.lease_id),
      workerId: text(row.worker_id),
      leaseUntil: date(row.lease_until)
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('PostgreSQL returned an invalid outbox row')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('PostgreSQL returned invalid text')
  return value
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value)
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('PostgreSQL returned invalid integer')
  return value
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError('PostgreSQL returned invalid enum value')
  return value as T[number]
}

function optionalDate(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : date(value)
}
