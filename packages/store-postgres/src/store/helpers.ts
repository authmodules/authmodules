import type { StoreFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import type { SecretFactory } from '@authmodules/contracts/security'
import type { ChallengeStore } from '@authmodules/contracts/store'
import type { TransactionFailure } from '@authmodules/contracts/transaction'
import { queryNullable } from '../database/query.ts'
import type { PostgresClient } from '../database/types.ts'
import { challengeFromRow } from '../records/mappers.ts'
import { storeErr } from '../shared/result.ts'

export function cleanupLimit(value: unknown): Result<number, StoreFailure> {
  if (value === undefined) return { ok: true, value: 1000 }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 1000) {
    return storeErr('STORE_UNAVAILABLE')
  }
  return { ok: true, value }
}

export function transactionFailure(): Result<never, TransactionFailure> {
  return {
    ok: false,
    error: {
      type: 'component.failure',
      component: 'transaction',
      reason: 'TRANSACTION_FAILED'
    }
  }
}

type ChallengeUpdateInput = Parameters<ChallengeStore['consumePending']>[0]

export async function updateChallengeStatus(
  client: PostgresClient,
  secretFactory: Pick<SecretFactory, 'protectedValue' | 'sealedValue'> | undefined,
  input: ChallengeUpdateInput,
  status: 'expired'
) {
  return queryNullable(client, (row) => challengeFromRow(row, secretFactory), `update authmodules_challenges
    set status = $4, version = version + 1, updated_at = $5
    where tenant_id = $1 and challenge_id = $2 and version = $3 and status = 'pending'
    returning *`, [input.tenantId, input.challengeId, input.expectedVersion, status, input.now])
}
