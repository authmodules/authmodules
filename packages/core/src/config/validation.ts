import type { PublicData } from '@authmodules/contracts/primitives'
import { isNonEmptyString } from '../validation/input.ts'
import { isStableMethodId } from '../validation/method.ts'

type ConfigIssue = {
  readonly path: readonly string[]
  readonly code: string
}

const MAX_SESSION_TTL_SECONDS = 3_155_760_000

export function validateConfig(config: unknown): PublicData | null {
  const issues: ConfigIssue[] = []
  if (!isRecord(config)) {
    return { issues: [{ path: ['config'], code: 'required' }] }
  }

  const methods = isPlainRecord(config.methods) ? config.methods : {}
  if ('carrier' in config) issues.push(issue(['carrier'], 'not-allowed-in-core-config'))
  if (!isRecord(config.store)) issues.push(issue(['store'], 'required'))
  if (!isPlainRecord(config.methods)) issues.push(issue(['methods'], 'plain-object-required'))
  if (!isRecord(config.token)) {
    issues.push(issue(['token'], 'required'))
  } else {
    requireFunction(issues, config.token, 'issue', ['token', 'issue'])
    requireFunction(issues, config.token, 'identify', ['token', 'identify'])
  }
  if (!isRecord(config.clock) || typeof config.clock.now !== 'function') {
    issues.push(issue(['clock'], 'required'))
  }
  if (!isRecord(config.idGenerator) || typeof config.idGenerator.generate !== 'function') {
    issues.push(issue(['idGenerator'], 'required'))
  }

  const session = isRecord(config.session) ? config.session : undefined
  const defaultTtlSeconds = session?.defaultTtlSeconds
  if (!isSessionTtl(defaultTtlSeconds)) {
    issues.push(issue(['session', 'defaultTtlSeconds'], 'positive-number-required'))
  }
  const maxTtlSeconds = session?.maxTtlSeconds
  if (maxTtlSeconds !== undefined
    && (!isSessionTtl(maxTtlSeconds)
      || typeof defaultTtlSeconds !== 'number'
      || maxTtlSeconds < defaultTtlSeconds)) {
    issues.push(issue(['session', 'maxTtlSeconds'], 'must-be-at-least-default'))
  }

  validateStoreConfig(config.store, issues)
  validateOptionalPort(config.effects, 'dispatch', ['effects', 'dispatch'], issues)
  validateTransactionScopes(config.effects, issues)
  validateOptionalPort(config.guard, 'beforeAttempt', ['guard', 'beforeAttempt'], issues)
  validateOptionalPort(config.guard, 'afterAttempt', ['guard', 'afterAttempt'], issues)
  validateOptionalPort(config.eventSink, 'emit', ['eventSink', 'emit'], issues)
  if (config.policy !== undefined && typeof config.policy !== 'function') {
    issues.push(issue(['policy'], 'function-required'))
  }

  for (const [key, value] of Object.entries(methods)) {
    if (!isRecord(value)) {
      issues.push(issue(['methods', key], 'object-required'))
      continue
    }
    if (!value.methodId) {
      issues.push(issue(['methods', key, 'methodId'], 'required'))
    } else if (!isStableMethodId(value.methodId)) {
      issues.push(issue(['methods', key, 'methodId'], 'stable-dot-namespace-required'))
    }
    if (key !== value.methodId) issues.push(issue(['methods', key], 'method-id-mismatch'))
    if (!isNonEmptyString(value.methodKind)) issues.push(issue(['methods', key, 'methodKind'], 'required'))
    if (!isRecord(value.operations)) {
      issues.push(issue(['methods', key, 'operations'], 'required'))
      continue
    }
    for (const operationName of ['enroll', 'authenticate', 'begin', 'complete']) {
      const operation = value.operations[operationName]
      if (operation === undefined) continue
      requireFunction(issues, operation, 'validate', ['methods', key, 'operations', operationName, 'validate'])
      requireFunction(issues, operation, 'run', ['methods', key, 'operations', operationName, 'run'])
    }
  }

  const needsChallengeStore = Object.values(methods).some((method) => {
    return isRecord(method)
      && isRecord(method.operations)
      && (method.operations.begin !== undefined || method.operations.complete !== undefined)
  })
  const store = isRecord(config.store) ? config.store : undefined
  const ephemeral = store && isRecord(store.ephemeral) ? store.ephemeral : undefined
  if (needsChallengeStore && (!ephemeral || !isRecord(ephemeral.challenges))) {
    issues.push(issue(['store', 'ephemeral', 'challenges'], 'required-for-challenge-methods'))
  }
  return issues.length > 0 ? { issues } : null
}

function isSessionTtl(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SESSION_TTL_SECONDS
}

function validateTransactionScopes(effects: unknown, issues: ConfigIssue[]): void {
  if (!isRecord(effects) || effects.transactionScopes === undefined) return
  const scopes = effects.transactionScopes
  if (!Array.isArray(scopes)
    || scopes.length === 0
    || scopes.length > 1000
    || new Set(scopes).size !== scopes.length
    || !scopes.every((scope) => (
      typeof scope === 'string'
      && scope.length > 0
      && scope.length <= 512
      && !/[\u0000-\u001f\u007f]/.test(scope)
    ))) {
    issues.push(issue(['effects', 'transactionScopes'], 'non-empty-unique-string-array-required'))
  }
}

function validateStoreConfig(store: unknown, issues: ConfigIssue[]): void {
  if (!isRecord(store)) return
  const required = [
    ['durable', 'accounts', 'create'],
    ['durable', 'accounts', 'findById'],
    ['durable', 'accounts', 'updateStatus'],
    ['durable', 'identities', 'create'],
    ['durable', 'identities', 'findById'],
    ['durable', 'identities', 'findBySubject'],
    ['durable', 'identities', 'markVerified'],
    ['durable', 'credentials', 'create'],
    ['durable', 'credentials', 'findById'],
    ['durable', 'credentials', 'findForIdentity'],
    ['durable', 'credentials', 'replaceMaterial'],
    ['durable', 'credentials', 'updateStatus'],
    ['session', 'sessions', 'create'],
    ['session', 'sessions', 'findById'],
    ['session', 'sessions', 'findByTokenHash'],
    ['session', 'sessions', 'revoke'],
    ['session', 'sessions', 'cleanupExpired']
  ] as const
  for (const path of required) {
    const owner = valueAtPath(store, path.slice(0, -1))
    requireFunction(issues, owner, path.at(-1)!, ['store', ...path])
  }
  if (store.transaction !== undefined) {
    requireFunction(issues, store.transaction, 'run', ['store', 'transaction', 'run'])
  }
  const ephemeral = isRecord(store.ephemeral) ? store.ephemeral : undefined
  const challenges = ephemeral && isRecord(ephemeral.challenges) ? ephemeral.challenges : undefined
  if (challenges) {
    for (const name of ['create', 'findById', 'recordFailedAttempt', 'consumePending', 'cleanupExpired']) {
      requireFunction(issues, challenges, name, ['store', 'ephemeral', 'challenges', name])
    }
  }
}

function requireFunction(
  issues: ConfigIssue[],
  owner: unknown,
  key: string,
  path: readonly string[]
): void {
  if (!isRecord(owner) || typeof owner[key] !== 'function') issues.push(issue(path, 'function-required'))
}

function validateOptionalPort(
  port: unknown,
  method: string,
  path: readonly string[],
  issues: ConfigIssue[]
): void {
  if (port !== undefined) requireFunction(issues, port, method, path)
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function issue(path: readonly string[], code: string): ConfigIssue {
  return { path, code }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
