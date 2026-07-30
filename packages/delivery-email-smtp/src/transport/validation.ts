import { isDeliveryMessage } from '../delivery/validation.ts'
import { isSafeAddress } from '../shared/address.ts'
import { isSafeText } from '../shared/json.ts'
import type { DeliverySendInput } from '@authmodules/contracts/delivery'
import type { SmtpRenderedMessage } from './types.ts'

const renderedMessageKeys = new Set(['headers', 'html', 'replyTo', 'subject', 'text'])
const reservedHeaderNames = new Set([
  'bcc',
  'cc',
  'content-transfer-encoding',
  'content-type',
  'date',
  'dkim-signature',
  'from',
  'message-id',
  'mime-version',
  'received',
  'reply-to',
  'return-path',
  'sender',
  'subject',
  'to'
])

export function isSendInput(input?: DeliverySendInput): input is DeliverySendInput {
  return Boolean(
    input &&
    isValidDate(input.now) &&
    (input.expiresAt === undefined || isValidDate(input.expiresAt)) &&
    (input.idempotencyKey === undefined || (isSafeText(input.idempotencyKey, 512) && input.idempotencyKey.length > 0)) &&
    isDeliveryMessage(input.message)
  )
}

function isValidDate(value: unknown): value is Date {
  if (!(value instanceof Date)) return false
  try {
    return Number.isFinite(Date.prototype.getTime.call(value))
  } catch {
    return false
  }
}

export function isRenderedMessage(value?: unknown): value is SmtpRenderedMessage {
  return isRecord(value)
    && Object.keys(value).every((key) => renderedMessageKeys.has(key))
    && typeof value.subject === 'string'
    && value.subject.length > 0
    && value.subject.length <= 998
    && !/[\u0000-\u001f\u007f]/.test(value.subject)
    && ((typeof value.text === 'string' && value.text.length <= 5_000_000)
      || (typeof value.html === 'string' && value.html.length <= 5_000_000))
    && (value.text === undefined || (typeof value.text === 'string' && value.text.length <= 5_000_000))
    && (value.html === undefined || (typeof value.html === 'string' && value.html.length <= 5_000_000))
    && (value.replyTo === undefined || isSafeAddress(value.replyTo))
    && (value.headers === undefined || isSafeHeaders(value.headers))
}

function isSafeHeaders(headers: unknown): headers is Readonly<Record<string, string>> {
  return isRecord(headers)
    && Object.keys(headers).length <= 100
    && Object.entries(headers).every(([key, value]): boolean => (
      key.length <= 256 &&
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) &&
      !reservedHeaderNames.has(key.toLowerCase()) &&
      typeof value === 'string' &&
      value.length <= 8192 &&
      !/[^\t\x20-\x7e\x80-\xff]/.test(value)
    ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
