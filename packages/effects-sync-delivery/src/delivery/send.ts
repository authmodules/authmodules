import { isJsonObject, isSafeText } from '../shared/json.ts'
import { deliveryFailure } from '../shared/result.ts'
import type { DeliverySendInput, DeliveryTransport } from '@authmodules/contracts/delivery'
import type { DeliveryFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'

export async function safeSend(transport: DeliveryTransport, input: DeliverySendInput): Promise<Result<Awaited<ReturnType<DeliveryTransport['send']>> extends Result<infer T, DeliveryFailure> ? T : never, DeliveryFailure>> {
  try {
    const result = await transport.send(input)
    if (result?.ok === true && result.value && typeof result.value === 'object') {
      const acceptedAt = result.value.acceptedAt
      const providerMessageId = result.value.providerMessageId
      const acceptedAtTimestamp = dateTimestamp(acceptedAt)
      if (acceptedAtTimestamp === undefined
        || (providerMessageId !== undefined
          && (!isSafeText(providerMessageId, 512) || providerMessageId.length === 0))) {
        return deliveryFailure()
      }
      return {
        ok: true,
        value: {
          acceptedAt: new Date(acceptedAtTimestamp),
          providerMessageId
        }
      }
    }
    if (result?.ok === false && result.error && typeof result.error === 'object') {
      const reason = result.error.reason
      const detailsSource = result.error.details
      const details = detailsSource === undefined ? undefined : structuredClone(detailsSource)
      if (isSafeText(reason, 512)
        && reason.length > 0
        && (details === undefined || isJsonObject(details))) {
        return {
          ok: false,
          error: {
            type: 'component.failure',
            component: 'delivery',
            reason,
            details
          }
        }
      }
    }
    return deliveryFailure()
  } catch {
    return deliveryFailure()
  }
}

function dateTimestamp(value: unknown): number | undefined {
  if (!(value instanceof Date)) return undefined
  const timestamp = Date.prototype.getTime.call(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}
