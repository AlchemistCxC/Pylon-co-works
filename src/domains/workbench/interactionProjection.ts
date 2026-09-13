/** Interaction projection policy: secret omission and terminal-state preservation.
 * No IO, clocks or stores. The parent projector supplies ordered, normalized envelopes.
 * Document imports are type-only to avoid a runtime cycle back to the reducer.
 */
import type { InteractionEvent, WorkbenchEventEnvelope } from './events/workbenchEventSchema.ts'
import type { WorkbenchDocument, WorkbenchInteraction } from './workbenchProjector.ts'

/** C12：secret-bearing interaction 的脱敏键清单——命中值永不落 journal/document/diagnostic。 */
const SENSITIVE_REQUEST_KEYS: ReadonlySet<string> = new Set(['password', 'secret', 'value', 'token', 'accesstoken', 'refreshtoken', 'clientsecret', 'apikey', 'authorization', 'credential', 'cookie'])
/** OAuth URL scheme 白名单（C12 步骤 2）；其余 scheme 的 url 字段整体剥除。 */
const OAUTH_URL_PATTERN = /^https:\/\/|^http:\/\/localhost/

/** C12：事件级剥敏——request/response 双字段；envelope.event 与 document.interactions 共享同一结果。 */
export function redactInteractionEvent<T extends Record<string, unknown>>(event: T): T {
  return {
    ...event,
    ...(event.request !== undefined ? { request: redactSensitiveInteractionPayload(event.request) } : {}),
    ...(event.response !== undefined ? { response: redactSensitiveInteractionPayload(event.response) } : {}),
  }
}

function redactSensitiveInteractionPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactSensitiveInteractionPayload)
  if (typeof payload !== 'object' || payload === null) return payload
  const source = payload as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.replace(/[_-]/g, '').toLowerCase()
    if (SENSITIVE_REQUEST_KEYS.has(normalizedKey)
      || normalizedKey.endsWith('token') || normalizedKey.endsWith('apikey') || normalizedKey.endsWith('secret')) {
      // omission metadata 替代原值（DIC-C12-01）：只留可审计的 redacted 标记
      if (value !== undefined && value !== null && value !== '') out[`${key}Redacted`] = true
      continue
    }
    if (key === 'url' && typeof value === 'string' && !OAUTH_URL_PATTERN.test(value)) {
      out.urlRedacted = true
      continue
    }
    out[key] = redactSensitiveInteractionPayload(value)
  }
  return out
}

/** C11：interaction 投影——结构化 request/response、终态幂等（首个 resolved/expired 权威，重复响应忽略）。 */
export function reduceInteraction(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: InteractionEvent): WorkbenchDocument {
  const id = event.interactionId || envelope.identity.interactionId || envelope.eventId
  const previous = document.interactions.find(item => item.id === id)
  // 幂等：已进入 resolved/expired 终态后，迟到的响应/过期事件只补缺字段不改写既有事实
  if (previous && previous.status !== 'requested') {
    if (previous.status === 'resolved') return document
    const filled: WorkbenchInteraction = {
      ...previous,
      ...(previous.response === undefined && event.response !== undefined ? { response: event.response } : {}),
      ...(previous.reason === undefined && event.reason !== undefined ? { reason: event.reason } : {}),
    }
    return { ...document, interactions: document.interactions.map(item => item.id === id ? filled : item) }
  }
  const status = event.type === 'interaction.requested' ? 'requested' : event.type === 'interaction.expired' ? 'expired' : 'resolved'
  const interaction: WorkbenchInteraction = {
    id,
    status,
    // request 由 requested 事件建立；resolved/expired 事件只携带 response/reason——保留原 request 不丢失
    // C12：request/response 在入投影前先剥敏感字段（wire 泄漏场景下 Pylon 不二次持久化）
    request: event.type === 'interaction.requested' ? redactSensitiveInteractionPayload(event.request) : previous?.request,
    response: event.response !== undefined ? redactSensitiveInteractionPayload(event.response) : previous?.response,

    reason: event.reason ?? previous?.reason,
    sequence: envelope.sequence,
  }
  return { ...document, interactions: [...document.interactions.filter(item => item.id !== id), interaction] }
}

