import type { AgentEventNormalizer, AgentWireEnvelope, NormalizeContext, NormalizeDiagnostic, NormalizeResult } from './agentEventNormalizer.ts'
import { normalizeAcpEvent } from './acpNormalizer.ts'
import { createDiagnostic, extractUpdate, isRecord, makeEnvelope, toJsonValue, wireKind } from './normalizerSupport.ts'
import type { JsonValue } from '../content/contentPartSchema.ts'
import type { WorkbenchEventEnvelope, WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'

export const periNormalizer: AgentEventNormalizer = {
  id: 'peri',
  canNormalize: (_input, context) => context.provider.toLowerCase() === 'peri',
  normalize: normalizePeriEvent,
}

export function normalizePeriEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const update = extractUpdate(input)
  const kind = wireKind(update)
  if (kind === 'peri/agent_event' || kind === 'peri/agent_event_done' || kind === 'peri/prediction_ready') {
    return normalizePeriExtensionEvent(kind, update, input, context)
  }
  if (kind === 'unstable-event' || kind === 'peri/unstable-event') {
    const diagnostic = createDiagnostic(context, update, 'peri.unstable-event', 'Peri unstable event is diagnostic-only and does not enter the timeline', ['sessionUpdate'], true)
    if (!context.observe) return { events: [], diagnostics: [diagnostic] }
    return {
      events: [makeEnvelope({ type: 'diagnostic.notice', level: 'info', message: diagnostic.message, code: diagnostic.code }, input, context, update)],
      diagnostics: [diagnostic],
    }
  }
  const result = normalizeAcpEvent(input, context)
  if (!context.seenEventKeys) return result
  const events = [] as typeof result.events[number][]
  const diagnostics = [...result.diagnostics]
  for (const event of result.events) {
    const key = stableEventKey(event)
    if (!key) {
      events.push(event)
      continue
    }
    if (context.seenEventKeys.has(key)) {
      diagnostics.push(createDiagnostic(context, update, 'duplicate.identity', 'duplicate Peri event identity ignored', ['identity'], true))
      continue
    }
    context.seenEventKeys.add(key)
    events.push(event)
  }
  return { events, diagnostics }
}

function stableEventKey(event: WorkbenchEventEnvelope): string | undefined {
  if (Object.keys(event.identity).length === 0) return undefined
  return JSON.stringify([event.source.provider, event.source.sourceId, event.identity, event.event.type])
}

// ── #315 Peri 私有扩展通道（Category ③/⑤）────────────────────────────────
//
// 内核把 `peri/*` 通知包络为 session/update 形状（判别符 = wire method 原名，
// 载荷字段原样保留；`event_json` 投影为 `eventJson`），本段是它们唯一的语义化
// 入口。映射目标全部是 workbenchEventSchema 已注册的语义事件（渲染插槽先于
// wire 就绪）；未知变体/malformed 走 event.unknown 兜底 + 诊断，raw 恒保留。
//
// 终态红线：`peri/agent_event_done` 是 peri 传输层的 turn-done 复写，「本回合
// 是否已收敛」的权威在内核 turn ledger（ADR-0017）——此处只留痕，绝不映射
// session.completed，避免双终态。

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizePeriExtensionEvent(
  kind: string,
  update: Record<string, unknown> | undefined,
  input: unknown,
  context: NormalizeContext,
): NormalizeResult {
  if (kind === 'peri/prediction_ready') {
    const placeholder = stringField(update?.text)
    const actions = Array.isArray(update?.actions) ? toJsonValue(update?.actions) as readonly JsonValue[] : undefined
    const event: WorkbenchSemanticEvent = {
      type: 'assist.prediction',
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(actions !== undefined ? { actions } : {}),
    }
    return { events: [makeEnvelope(event, input, context, update)], diagnostics: [] }
  }
  if (kind === 'peri/agent_event_done') {
    const diagnostic = createDiagnostic(
      context, update, 'peri.turn-done',
      'peri transport turn-done observed; turn terminal authority stays with the kernel ledger',
      ['sessionUpdate'], true,
    )
    const stopReason = stringField(update?.stopReason)
    const requestId = stringField(update?.requestId)
    const event: WorkbenchSemanticEvent = {
      type: 'diagnostic.notice',
      level: 'info',
      message: 'provider reported turn completion (transport-level)',
      code: 'peri.turn-done',
      data: toJsonValue({
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      }),
    }
    return { events: [makeEnvelope(event, input, context, update)], diagnostics: [diagnostic] }
  }
  return normalizePeriAgentEvent(update, input, context)
}

/** AcpEvent DTO 的 serde `tag = "type", content = "value"` 形状。 */
function parseAcpEventPayload(eventJson: unknown): { eventType: string; value: Record<string, unknown> } | undefined {
  if (typeof eventJson !== 'string' || !eventJson.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(eventJson)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string' || !parsed.type.trim()) return undefined
  return {
    eventType: parsed.type,
    value: isRecord(parsed.value) ? parsed.value : {},
  }
}

function normalizePeriAgentEvent(
  update: Record<string, unknown> | undefined,
  input: unknown,
  context: NormalizeContext,
): NormalizeResult {
  const parsed = parseAcpEventPayload(update?.eventJson)
  if (!parsed) {
    const diagnostic = createDiagnostic(
      context, update, 'peri.agent-event-malformed',
      'peri/agent_event eventJson is not a parseable AcpEvent payload',
      ['eventJson'], true,
    )
    const unknown = createUnknownPeriEvent(update, 'peri/agent_event')
    return { events: [makeEnvelope(unknown, input, context, update)], diagnostics: [diagnostic] }
  }
  const { eventType, value } = parsed
  const diagnostics: NormalizeDiagnostic[] = []
  const event = mapAcpEventValue(eventType, value, diagnostics, context, update)
  if (event === undefined) {
    diagnostics.push(createDiagnostic(
      context, update, 'peri.agent-event-unknown',
      `unknown peri AcpEvent variant: ${eventType}`,
      ['eventJson'], true,
    ))
    return { events: [makeEnvelope(createUnknownPeriEvent(value, eventType), input, context, update)], diagnostics }
  }
  return { events: [makeEnvelope(event, input, context, update)], diagnostics }
}

function createUnknownPeriEvent(value: unknown, originalType: string): WorkbenchSemanticEvent {
  const raw = toJsonValue(value)
  const summary = typeof raw === 'string' ? raw.slice(0, 120) : JSON.stringify(raw).slice(0, 120)
  return { type: 'event.unknown', originalType, summary, raw, truncated: false }
}

/** AcpEvent（peri-acp event/mod.rs，snake_case）→ workbench 语义事件。
 *  无 peri 侧语义的变体（TurnCommitted/StateSnapshot 全量消息快照）不在此通道
 *  消费，返回 undefined 走 unknown 兜底；数据不丢（raw 恒保留）。 */
function mapAcpEventValue(
  eventType: string,
  value: Record<string, unknown>,
  diagnostics: NormalizeDiagnostic[],
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
): WorkbenchSemanticEvent | undefined {
  switch (eventType) {
    case 'subagent_started':
    case 'subagent_stopped': {
      const activityId = stringField(value.instance_id) ?? stringField(value.agent_name) ?? 'peri-subagent'
      const name = stringField(value.agent_name)
      const background = typeof value.is_background === 'boolean' ? value.is_background : undefined
      const activity = toJsonValue({ kind: 'subagent', ...(name !== undefined ? { name } : {}), ...(background !== undefined ? { background } : {}) })
      if (eventType === 'subagent_started') {
        return { type: 'activity.started', activityId, activity }
      }
      const isError = value.is_error === true
      const resultText = stringField(value.result)
      const base = { activityId, activity }
      return isError
        ? { type: 'activity.failed', ...base, error: toJsonValue({ ...(resultText !== undefined ? { message: resultText } : {}) }) }
        : { type: 'activity.completed', ...base, ...(resultText !== undefined ? { result: toJsonValue({ text: resultText }) } : {}) }
    }
    case 'compact_started':
      return { type: 'lifecycle.compact-started' }
    case 'compact_completed': {
      const summary = stringField(value.summary)
      const strategy = stringField(value.strategy)
      const trigger = stringField(value.trigger)
      const files = Array.isArray(value.files) ? toJsonValue(value.files) as readonly JsonValue[] : undefined
      return {
        type: 'lifecycle.compact-completed',
        ...(summary !== undefined ? { summary } : {}),
        ...(strategy !== undefined ? { strategy } : {}),
        ...(trigger !== undefined ? { trigger } : {}),
        ...(files !== undefined ? { files } : {}),
      }
    }
    case 'compact_error': {
      const message = stringField(value.message) ?? 'peri compact failed'
      return { type: 'diagnostic.notice', level: 'error', message, code: 'peri.compact-error' }
    }
    case 'rewind_completed': {
      const summary = stringField(value.summary)
      return { type: 'lifecycle.rewind-completed', ...(summary !== undefined ? { summary } : {}) }
    }
    case 'rewind_error': {
      const message = stringField(value.message) ?? 'peri rewind failed'
      return { type: 'diagnostic.notice', level: 'error', message, code: 'peri.rewind-error' }
    }
    case 'turn_suspended': {
      const turnId = stringField(value.turn_id)
      return { type: 'lifecycle.suspended', ...(turnId !== undefined ? { reason: `turn ${turnId} suspended` } : {}) }
    }
    case 'background_task_completed': {
      const activityId = stringField(value.task_id) ?? stringField(value.child_thread_id) ?? 'peri-background-task'
      const name = stringField(value.agent_name)
      const output = stringField(value.output)
      const durationMs = finiteNumber(value.duration_ms)
      const base = { activityId, activity: toJsonValue({ kind: 'background-task', ...(name !== undefined ? { name } : {}) }) }
      if (value.success === false) {
        return { type: 'activity.failed', ...base, error: toJsonValue({ ...(output !== undefined ? { message: output } : {}) }) }
      }
      return {
        type: 'activity.completed',
        ...base,
        ...(output !== undefined || durationMs !== undefined
          ? { result: toJsonValue({ ...(output !== undefined ? { text: output } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }) }
          : {}),
      }
    }
    case 'bg_tool_step': {
      const activityId = stringField(value.child_thread_id) ?? 'peri-background-task'
      return { type: 'activity.progress', activityId, activity: toJsonValue({ kind: 'background-task' }) }
    }
    case 'lsp_diagnostics': {
      const errors = finiteNumber(value.errors)
      const warnings = finiteNumber(value.warnings)
      const filesWithErrors = finiteNumber(value.files_with_errors)
      return {
        type: 'diagnostic.updated',
        diagnostics: [toJsonValue({
          source: 'lsp',
          ...(errors !== undefined ? { errors } : {}),
          ...(warnings !== undefined ? { warnings } : {}),
          ...(filesWithErrors !== undefined ? { filesWithErrors } : {}),
        })],
      }
    }
    case 'agent_execution_failed': {
      const message = stringField(value.message) ?? 'peri agent execution failed'
      return { type: 'diagnostic.notice', level: 'error', message, code: 'peri.agent-execution-failed' }
    }
    case 'context_warning': {
      const used = finiteNumber(value.used_tokens)
      const limit = finiteNumber(value.total_tokens)
      const percent = finiteNumber(value.percentage)
      return {
        type: 'budget.warning',
        ...(used !== undefined ? { used } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(percent !== undefined ? { percent } : {}),
      }
    }
    case 'system_notification': {
      const message = stringField(value.text) ?? 'peri system notification'
      const level = value.level === 'error' ? 'error' : value.level === 'warn' ? 'warning' : 'info'
      return { type: 'diagnostic.notice', level, message, code: 'peri.system-notification' }
    }
    case 'oauth_needed': {
      const serverName = stringField(value.server_name) ?? 'unknown-server'
      const authUrl = stringField(value.auth_url)
      return {
        type: 'interaction.requested',
        interactionId: `peri-oauth-${serverName}`,
        request: toJsonValue({ kind: 'oauth', serverName, ...(authUrl !== undefined ? { authUrl } : {}) }),
      }
    }
    case 'oauth_completed':
    case 'oauth_failed': {
      const serverName = stringField(value.server_name) ?? 'unknown-server'
      const error = stringField(value.error)
      return {
        type: 'interaction.resolved',
        interactionId: `peri-oauth-${serverName}`,
        response: toJsonValue({ outcome: eventType === 'oauth_completed' ? 'completed' : 'failed', ...(error !== undefined ? { error } : {}) }),
      }
    }
    case 'oauth_restored': {
      const serverName = stringField(value.server_name)
      return {
        type: 'diagnostic.notice',
        level: 'info',
        message: `OAuth credentials restored${serverName !== undefined ? ` (${serverName})` : ''}`,
        code: 'peri.oauth-restored',
      }
    }
    case 'llm_retrying': {
      const attempt = finiteNumber(value.attempt)
      const maxAttempts = finiteNumber(value.max_attempts)
      const delayMs = finiteNumber(value.delay_ms)
      const error = stringField(value.error)
      return {
        type: 'lifecycle.retrying',
        ...(attempt !== undefined ? { attempt } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(error !== undefined ? { error } : {}),
      }
    }
    case 'workflow_progress': {
      const activityId = stringField(value.run_id) ?? 'peri-workflow'
      const name = stringField(value.workflow_name)
      const status = stringField(value.run_status)
      const base = { activityId, activity: toJsonValue({ kind: 'workflow', ...(name !== undefined ? { name } : {}) }) }
      if (status === 'failed' || status === 'error') {
        const message = stringField(value.message)
        return { type: 'activity.failed', ...base, error: toJsonValue({ ...(message !== undefined ? { message } : {}), runStatus: status }) }
      }
      return {
        type: 'activity.progress',
        ...base,
        patch: toJsonValue({
          eventType: stringField(value.event_type),
          phase: stringField(value.phase),
          label: stringField(value.label),
          agentStatus: stringField(value.agent_status),
          tokenCount: finiteNumber(value.token_count),
          toolCount: finiteNumber(value.tool_count),
          runStatus: status,
          message: stringField(value.message),
        }),
      }
    }
    case 'state_snapshot_meta': {
      // total_tokens 是累计 token（peri v2 暂为 0），不冒充 contextUsed；
      // budget_pct 是 0-1，投影统一 0-100 口径。
      const limit = finiteNumber(value.context_total_tokens)
      const budgetPct = finiteNumber(value.budget_pct)
      const usage = toJsonValue({
        ...(limit !== undefined ? { contextLimit: limit } : {}),
        ...(budgetPct !== undefined ? { contextPercent: Math.min(100, Math.max(0, budgetPct * 100)) } : {}),
        steps: finiteNumber(value.current_step) ?? 0,
        messageCount: finiteNumber(value.message_count) ?? 0,
        consecutiveFailures: finiteNumber(value.consecutive_failures) ?? 0,
      })
      diagnostics.push(createDiagnostic(
        context, update, 'peri.snapshot-meta-projected',
        'StateSnapshotMeta projected to usage.updated (cumulative token counter not mapped to contextUsed)',
        ['eventJson'], true,
      ))
      return { type: 'usage.updated', usage }
    }
    default:
      return undefined
  }
}
