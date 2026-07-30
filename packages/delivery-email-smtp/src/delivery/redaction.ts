import type { DeliveryMessage } from '@authmodules/contracts/delivery'
import { isDeliveryMessage } from './validation.ts'

export function redactDeliveryMessage(message: DeliveryMessage): DeliveryMessage

export function redactDeliveryMessage(message: DeliveryMessage): DeliveryMessage {
  if (!isDeliveryMessage(message)) throw new TypeError('Delivery message is invalid')
  return {
    to: { ...message.to },
    templateId: message.templateId,
    locale: message.locale,
    metadata: message.metadata === undefined ? undefined : structuredClone(message.metadata),
    data: message.data === undefined
      ? undefined
      : redactValue(message.data, { visiting: new Set(), nodes: 0 }) as DeliveryMessage['data']
  }
}

function redactValue(value: unknown, state: { visiting: Set<object>; nodes: number }): unknown {
  state.nodes += 1
  if (state.nodes > 1000) throw new TypeError('Delivery data is too large')
  if (value && typeof value === 'object') {
    if (isRawSecret(value)) {
      return '[REDACTED]'
    }
    if (state.visiting.has(value)) throw new TypeError('Delivery data must not contain cycles')
    state.visiting.add(value)
    try {
      if (Array.isArray(value)) {
        return value.map((item: unknown): unknown => redactValue(item, state))
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, item]): [string, unknown] => [key, redactValue(item, state)])
      )
    } finally {
      state.visiting.delete(value)
    }
  }
  return value
}

function isRawSecret(value: object): value is {
  readonly type: 'raw-secret'
  readonly redacted: string
  reveal(): string
  toJSON(): string
} {
  return !Array.isArray(value)
    && Object.keys(value).every((key) => ['redacted', 'reveal', 'toJSON', 'type'].includes(key))
    && 'type' in value
    && value.type === 'raw-secret'
    && 'redacted' in value
    && typeof value.redacted === 'string'
    && 'reveal' in value
    && typeof value.reveal === 'function'
    && 'toJSON' in value
    && typeof value.toJSON === 'function'
}
