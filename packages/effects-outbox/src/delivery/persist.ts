import type { DeliveryMessage } from '@authmodules/contracts/delivery'
import type { PersistableDeliveryMessage } from '@authmodules/contracts/extensions'
import type { Result } from '@authmodules/contracts/result'
import { snapshotPersistableDeliveryMessage } from './validation.ts'

type PersistableDeliveryCandidate = Omit<DeliveryMessage, 'data'> & {
  readonly data?: unknown
}

export function toPersistableDeliveryMessage(
  message: PersistableDeliveryCandidate
): Result<PersistableDeliveryMessage, 'raw-secret'> {
  const snapshot = snapshotPersistableDeliveryMessage(message)
  if (snapshot) {
    return {
      ok: true,
      value: snapshot
    }
  }
  return {
    ok: false,
    error: 'raw-secret'
  }
}
