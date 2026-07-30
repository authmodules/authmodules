import type { MethodFailure } from '@authmodules/contracts/errors'
import type { Result } from '@authmodules/contracts/result'
import type { OtpMethodOptions } from '../method/types.ts'
import { isSafeText } from '../method/options.ts'
import { methodErr } from '../shared/errors.ts'
import { ok } from '../shared/result.ts'

type ResolveDeliveryTarget = NonNullable<OtpMethodOptions['resolveDeliveryTarget']>
type ResolveDeliveryTargetInput = Parameters<ResolveDeliveryTarget>[0]

export async function safeResolveDeliveryTarget(
  resolveDeliveryTarget: ResolveDeliveryTarget,
  input: ResolveDeliveryTargetInput
): Promise<Result<string, MethodFailure>> {
  try {
    const target = await resolveDeliveryTarget({
      lookup: { ...input.lookup },
      context: {
        tenantId: input.context.tenantId,
        requestId: input.context.requestId,
        actor: input.context.actor ? structuredClone(input.context.actor) : undefined,
        ip: input.context.ip,
        userAgent: input.context.userAgent,
        locale: input.context.locale,
        policyInput: input.context.policyInput
          ? structuredClone(input.context.policyInput)
          : undefined
      }
    })
    return isSafeText(target, 1024) && target.trim() !== ''
      ? ok(target)
      : methodErr('DELIVERY_FAILED')
  } catch {
    return methodErr('DELIVERY_FAILED')
  }
}
