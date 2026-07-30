import type {
  DeliveryMessage,
  DeliverySendInput,
  DeliveryTransport
} from '@authmodules/contracts/delivery'
import type { DeliveryData, RawSecretValue } from '@authmodules/contracts/security'
import {
  type SmtpDeliveryTransportOptions,
  type SmtpRenderedMessage
} from './types.ts'
import { isSafeAddress } from '../shared/address.ts'
import { isRenderedMessage, isSendInput } from './validation.ts'
import { normalizeDispatchContext } from '../shared/context.ts'
import { isSafeText } from '../shared/json.ts'
import { deliveryFailure } from '../shared/result.ts'

export function createSmtpDeliveryTransport(options: SmtpDeliveryTransportOptions): DeliveryTransport

export function createSmtpDeliveryTransport(options: SmtpDeliveryTransportOptions): DeliveryTransport {
  if (!options || typeof options !== 'object') throw new TypeError('SMTP options are required')
  const client = options.client
  const render = options.render
  const from = options.from
  const nowProvider = options.now ?? (() => new Date())
  if (!client || typeof client.sendMail !== 'function') throw new TypeError('SMTP client.sendMail is required')
  if (typeof render !== 'function') throw new TypeError('SMTP render function is required')
  if (typeof from !== 'string' && typeof from !== 'function') throw new TypeError('SMTP from address is required')
  if (typeof nowProvider !== 'function') throw new TypeError('SMTP now provider is invalid')

  return {
    async send(input?: DeliverySendInput) {
      try {
        if (!isPlainObject(input)) return deliveryFailure()
        const contextSource = input.context
        const messageSource = input.message
        const idempotencyKey = input.idempotencyKey
        const nowSource = input.now
        const expiresAtSource = input.expiresAt
        const context = normalizeDispatchContext(contextSource)
        const message = snapshotDeliveryMessage(messageSource)
        const now = snapshotDate(nowSource)
        const expiresAt = expiresAtSource === undefined ? undefined : snapshotDate(expiresAtSource)
        if (!message
          || !context
          || !now
          || (expiresAtSource !== undefined && !expiresAt)
          || !isSendInput({ context, message, idempotencyKey, expiresAt, now })) {
          return deliveryFailure()
        }
        const effectiveLocale = message.locale ?? context.locale
        const rendererMessage = snapshotDeliveryMessage(message)
        if (!rendererMessage) {
          return deliveryFailure()
        }
        const renderedOutput = await render({
          context: structuredClone(context),
          message: rendererMessage,
          idempotencyKey,
          effectiveLocale,
          now: new Date(now.getTime())
        })
        const sender = typeof from === 'function'
          ? await from({
              context: structuredClone(context),
              to: {
                channel: message.to.channel,
                target: message.to.target,
                ...(message.to.display === undefined ? {} : { display: message.to.display })
              },
              templateId: message.templateId,
              metadata: message.metadata ? structuredClone(message.metadata) : undefined,
              idempotencyKey,
              effectiveLocale,
              now: new Date(now.getTime())
            })
          : from
        const rendered = snapshotRenderedMessage(renderedOutput)
        if (!isSafeAddress(sender) || !rendered) return deliveryFailure()
        const providerStartedAt = readNow(nowProvider, now)
        if (!providerStartedAt || (expiresAt && expiresAt <= providerStartedAt)) {
          return deliveryFailure()
        }
        const result = await client.sendMail({
          from: sender,
          to: message.to.target,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          replyTo: rendered.replyTo,
          headers: rendered.headers,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey })
        })
        const completedAt = readNow(nowProvider, providerStartedAt) ?? providerStartedAt
        return {
          ok: true,
          value: snapshotProviderReceipt(result, completedAt)
        }
      } catch {
        return deliveryFailure()
      }
    }
  }
}

function snapshotProviderReceipt(
  value: unknown,
  fallbackAcceptedAt: Date
): { readonly providerMessageId?: string; readonly acceptedAt: Date } {
  try {
    if (!value || typeof value !== 'object') {
      return { acceptedAt: new Date(Date.prototype.getTime.call(fallbackAcceptedAt)) }
    }
    const providerMessageIdSource = (value as Record<string, unknown>).providerMessageId
    const acceptedAtSource = (value as Record<string, unknown>).acceptedAt
    const providerMessageId = isSafeText(providerMessageIdSource, 512)
      && providerMessageIdSource.length > 0
      ? providerMessageIdSource
      : undefined
    const acceptedAt = snapshotDate(acceptedAtSource) ?? fallbackAcceptedAt
    return {
      ...(providerMessageId === undefined ? {} : { providerMessageId }),
      acceptedAt: new Date(Date.prototype.getTime.call(acceptedAt))
    }
  } catch {
    return { acceptedAt: new Date(Date.prototype.getTime.call(fallbackAcceptedAt)) }
  }
}

function readNow(
  provider: NonNullable<SmtpDeliveryTransportOptions['now']>,
  fallback: Date
): Date | undefined {
  try {
    return snapshotDate(provider({
      now: new Date(Date.prototype.getTime.call(fallback))
    }))
  } catch {
    return undefined
  }
}

function snapshotDate(value: unknown): Date | undefined {
  if (!(value instanceof Date)) return undefined
  try {
    const timestamp = Date.prototype.getTime.call(value)
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined
  } catch {
    return undefined
  }
}

function snapshotDeliveryMessage(message: unknown): DeliveryMessage | undefined {
  if (!isPlainObject(message)) return undefined
  const toSource = message.to
  if (!isPlainObject(toSource)) return undefined
  const channel = toSource.channel
  const target = toSource.target
  const display = toSource.display
  const templateId = message.templateId
  const dataSource = message.data
  const locale = message.locale
  const metadataSource = message.metadata
  const budget = { secretCharacters: 0 }
  return {
    to: { channel, target, display },
    templateId,
    data: snapshotDeliveryData(dataSource as DeliveryData | undefined, budget),
    locale,
    metadata: metadataSource === undefined ? undefined : structuredClone(metadataSource)
  } as DeliveryMessage
}

function snapshotRenderedMessage(value: unknown): SmtpRenderedMessage | undefined {
  if (!isPlainObject(value)) return undefined
  const keys = Object.keys(value)
  if (keys.some((key) => !['headers', 'html', 'replyTo', 'subject', 'text'].includes(key))) {
    return undefined
  }
  const headers = Object.hasOwn(value, 'headers')
    ? snapshotStringRecord(value.headers)
    : undefined
  if (Object.hasOwn(value, 'headers') && headers === undefined) return undefined
  const snapshot = {
    subject: value.subject,
    ...(Object.hasOwn(value, 'text') ? { text: value.text } : {}),
    ...(Object.hasOwn(value, 'html') ? { html: value.html } : {}),
    ...(Object.hasOwn(value, 'replyTo') ? { replyTo: value.replyTo } : {}),
    ...(Object.hasOwn(value, 'headers') ? { headers } : {})
  }
  return isRenderedMessage(snapshot) ? snapshot : undefined
}

function snapshotStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isPlainObject(value)) return undefined
  return Object.fromEntries(Object.keys(value).map((key) => [key, value[key]])) as Record<string, string>
}

function snapshotDeliveryData(
  data: DeliveryData | undefined,
  budget: { secretCharacters: number }
): DeliveryData | undefined {
  if (!data) return undefined
  return Object.fromEntries(Object.entries(data).map(([key, value]) => {
    const secret = snapshotRawSecret(value, budget)
    return [key, secret ?? structuredClone(value)]
  }))
}

function snapshotRawSecret(
  value: unknown,
  budget: { secretCharacters: number }
): RawSecretValue | undefined {
  if (!isPlainObject(value)) return undefined
  const type = value.type
  if (type !== 'raw-secret') return undefined
  const reveal = value.reveal
  if (typeof reveal !== 'function') throw new TypeError('Raw secret is invalid')
  const revealed = reveal.call(value)
  if (typeof revealed !== 'string' || revealed.length === 0) throw new TypeError('Raw secret is invalid')
  budget.secretCharacters += revealed.length
  if (budget.secretCharacters > 1_000_000) throw new TypeError('Delivery secrets are too large')
  const redacted = '[REDACTED]'
  return Object.freeze({
    type: 'raw-secret' as const,
    redacted,
    reveal() {
      return revealed
    },
    toJSON() {
      return redacted
    }
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
