export function isStableMethodId(methodId: unknown): methodId is string {
  return typeof methodId === 'string'
    && methodId.length <= 128
    && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(methodId)
}
