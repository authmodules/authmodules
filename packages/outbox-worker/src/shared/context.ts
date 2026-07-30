import type { DispatchContext } from '@authmodules/contracts/primitives'
import { clonePublicData, isJsonObject, isSafeText } from './json.ts'

export function normalizeDispatchContext(context: unknown): DispatchContext | null {
  try {
    if (!isRecord(context)) return null
    const tenantId = context.tenantId
    const requestId = context.requestId
    const locale = context.locale
    const metadataSource = context.metadata
    const metadata = metadataSource === undefined ? undefined : structuredClone(metadataSource)
    if (!isSafeText(tenantId, 512) || tenantId.length === 0
      || (requestId !== undefined && (!isSafeText(requestId, 512) || requestId.length === 0))
      || (locale !== undefined && (!isSafeText(locale, 128) || locale.length === 0))
      || (metadata !== undefined && !isJsonObject(metadata))) return null
    return {
      tenantId,
      ...(requestId === undefined ? {} : { requestId }),
      ...(locale === undefined ? {} : { locale }),
      ...(metadata === undefined ? {} : { metadata: clonePublicData(metadata) })
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
