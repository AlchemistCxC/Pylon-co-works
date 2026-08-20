import { resolveActivity, type InteractionKind } from './activity.ts'

export type InteractionState =
  | 'waiting'
  | 'submitting'
  | 'answered'
  | 'cancelled'
  | 'expired'
  | 'failed'

export interface InteractionIdentity {
  provider: string | null
  agentId: string | null
  requestId: string | null
  sessionId: string | null
  toolCallId: string | null
  clientGeneration: number | null
}

export interface InteractionEventEnvelope {
  provider: string
  agentId?: string
  sessionId?: string
  eventType: string
  requestId?: string
  toolCallId?: string
  clientGeneration?: number
  payload: unknown
}

export interface InteractionOption {
  id: string
  label: string
  description?: string
}

export interface InteractionQuestion {
  id: string
  header?: string
  question: string
  options: InteractionOption[]
  allowMultiple: boolean
  allowFreeform: boolean
  placeholder?: string
}

export interface InteractionRequest {
  surface: 'interaction'
  kind: InteractionKind
  identity: InteractionIdentity
  title?: string
  questions: InteractionQuestion[]
  state: InteractionState
  /** 仅用于调试/trace 的协议来源，不保存原始 prompt 或答案。 */
  eventType?: string
}

/** P1-1：interaction 事务身份——唯一识别一次可提交的 interaction 请求。
 * 同 provider 多 agentId / 同 agent 多 session 的请求据此隔离，不串槽。 */
export interface InteractionTransaction {
  agentId: string
  sessionId: string
  requestId: string
  toolCallId?: string
  /** 旧消息/缺失时 null；非空时必须匹配（后端 stale 保护） */
  clientGeneration: number | null
}

/** 规范化事务 key（JSON 数组定序序列化，含 identity 全字段）。 */
export function makeInteractionTransactionKey(tx: InteractionTransaction): string {
  return JSON.stringify([
    tx.agentId,
    tx.sessionId,
    tx.requestId,
    tx.toolCallId ?? null,
    tx.clientGeneration ?? null,
  ])
}

/** 从统一 envelope 提取事务身份；缺 agentId/sessionId/requestId 返回 null（不可提交）。 */
export function transactionFromEnvelope(envelope: InteractionEventEnvelope): InteractionTransaction | null {
  if (!envelope.agentId || !envelope.sessionId || !envelope.requestId) return null
  return {
    agentId: envelope.agentId,
    sessionId: envelope.sessionId,
    requestId: envelope.requestId,
    toolCallId: envelope.toolCallId,
    clientGeneration: envelope.clientGeneration ?? null,
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = stringValue(value)
    if (result) return result
  }
  return undefined
}

function identityFrom(payload: Record<string, unknown>, metadata: Record<string, unknown>): InteractionIdentity {
  return {
    provider: firstString(metadata.provider, payload.provider) ?? null,
    agentId: firstString(metadata.agentId, metadata.agent_id, payload.agentId, payload.agent_id) ?? null,
    requestId: firstString(payload.request_id, payload.requestId, metadata.request_id, metadata.requestId) ?? null,
    sessionId: firstString(payload.session_id, payload.sessionId, metadata.session_id, metadata.sessionId) ?? null,
    toolCallId: firstString(payload.tool_call_id, payload.toolCallId, metadata.tool_call_id, metadata.toolCallId) ?? null,
    clientGeneration: typeof metadata.clientGeneration === 'number'
      ? metadata.clientGeneration
      : typeof payload.clientGeneration === 'number' ? payload.clientGeneration : null,
  }
}

export function normalizeInteractionEnvelope(value: unknown): InteractionEventEnvelope | null {
  const envelope = objectValue(value)
  const provider = stringValue(envelope.provider)
  const eventType = stringValue(envelope.eventType ?? envelope.event_type)
  if (!provider || !eventType || !('payload' in envelope)) return null
  return {
    provider,
    agentId: stringValue(envelope.agentId ?? envelope.agent_id),
    sessionId: stringValue(envelope.sessionId ?? envelope.session_id),
    eventType,
    requestId: firstString(envelope.requestId, envelope.request_id),
    toolCallId: stringValue(envelope.toolCallId ?? envelope.tool_call_id),
    clientGeneration: typeof envelope.clientGeneration === 'number' ? envelope.clientGeneration : undefined,
    payload: envelope.payload,
  }
}

export function interactionRequestFromEnvelope(envelope: InteractionEventEnvelope): InteractionRequest | null {
  return normalizeInteractionRequest({
    payload: envelope.payload,
    eventType: envelope.eventType,
    metadata: envelope,
  })
}

function uniqueId(base: string, index: number, used: Set<string>): string {
  const normalized = base.trim() || `option-${index + 1}`
  let id = normalized
  let suffix = 2
  while (used.has(id)) id = `${normalized}-${suffix++}`
  used.add(id)
  return id
}

function normalizeOptions(raw: unknown): InteractionOption[] {
  if (!Array.isArray(raw)) return []
  const used = new Set<string>()
  const options: InteractionOption[] = []
  raw.forEach((item, index) => {
    if (typeof item === 'string') {
      const label = stringValue(item)
      if (!label) return
      options.push({ id: uniqueId(label, index, used), label })
      return
    }
    const option = objectValue(item)
    const label = firstString(option.label, option.name, option.title, option.value)
    if (!label) return
    options.push({
      id: uniqueId(firstString(option.id, option.option_id, option.optionId, label) ?? label, index, used),
      label,
      description: stringValue(option.description),
    })
  })
  return options
}

function normalizeQuestion(raw: unknown, index: number): InteractionQuestion | null {
  const question = objectValue(raw)
  const text = firstString(question.question, question.prompt, question.text)
  if (!text) return null
  const options = normalizeOptions(question.options ?? question.choices)
  return {
    id: firstString(question.id, question.question_id, question.questionId) ?? `question-${index + 1}`,
    header: stringValue(question.header),
    question: text,
    options,
    allowMultiple: question.multi_select === true || question.allowMultiple === true || question.allow_multiple === true,
    allowFreeform: question.allowFreeform === true || question.allow_freeform === true || options.length === 0,
    placeholder: stringValue(question.placeholder),
  }
}

function questionsFrom(payload: Record<string, unknown>, kind: InteractionKind): InteractionQuestion[] {
  if (Array.isArray(payload.questions)) {
    return payload.questions.map(normalizeQuestion).filter((value): value is InteractionQuestion => value !== null)
  }
  const question = normalizeQuestion(payload, 0)
  if (question) return [question]
  if (kind === 'approval') {
    const prompt = firstString(payload.description, payload.command, payload.prompt)
    return prompt ? [{
      id: 'approval',
      question: prompt,
      options: normalizeOptions(payload.choices),
      allowMultiple: false,
      allowFreeform: false,
    }] : []
  }
  return []
}

/**
 * 将独立 Gateway/custom event 或工具请求转换成统一 InteractionRequest。
 * 缺失 identity 不会被本地补 UUID；这样调用方不会把一次未知请求错误地当成可提交事务。
 */
export function normalizeInteractionRequest(input: {
  payload: unknown
  eventType?: string
  name?: string
  metadata?: unknown
}): InteractionRequest | null {
  const payload = objectValue(input.payload)
  const metadata = objectValue(input.metadata)
  const activity = resolveActivity({ name: input.name ?? stringValue(payload.name), eventType: input.eventType, surface: stringValue(payload.surface) })
  if (activity.surface !== 'interaction') return null
  return {
    surface: 'interaction',
    kind: activity.interactionKind ?? 'unknown',
    identity: identityFrom(payload, metadata),
    title: firstString(payload.title, payload.header),
    questions: questionsFrom(payload, activity.interactionKind ?? 'unknown'),
    state: 'waiting',
    eventType: input.eventType,
  }
}
