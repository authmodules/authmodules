import type { CreateAuthConfig } from '@authmodules/contracts/core'
import type { AuthEvent } from '@authmodules/contracts/observability'
import type { AuthContext } from '@authmodules/contracts/primitives'
import { isValidDate } from '../validation/input.ts'
import { readNow } from '../shared/time.ts'

type AuthEventDraft = Omit<AuthEvent, 'tenantId' | 'requestId' | 'occurredAt'>

export async function emitEvent(
  config: CreateAuthConfig,
  context: AuthContext,
  event: AuthEventDraft,
  occurredAt?: Date
): Promise<void> {
  if (!config.eventSink || typeof config.eventSink.emit !== 'function') return
  const eventTime = occurredAt === undefined
    ? readNow(config)
    : isValidDate(occurredAt)
      ? new Date(occurredAt.getTime())
      : undefined
  if (!eventTime) return
  try {
    await config.eventSink.emit({
      ...event,
      tenantId: context.tenantId,
      requestId: context.requestId,
      occurredAt: eventTime
    })
  } catch {
    // Event sinks are explicitly best-effort observability.
  }
}
