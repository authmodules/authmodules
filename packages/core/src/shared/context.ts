import type {
  AuthContext,
  DecisionAuthContext
} from '@authmodules/contracts/primitives'

export function decisionAuthContext(context: AuthContext): DecisionAuthContext {
  return {
    tenantId: context.tenantId,
    requestId: context.requestId,
    actor: context.actor ? structuredClone(context.actor) : undefined,
    ip: context.ip,
    userAgent: context.userAgent,
    locale: context.locale,
    policyInput: context.policyInput ? structuredClone(context.policyInput) : undefined
  }
}
