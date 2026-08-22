/**
 * A04：唯一 Workbench projector。
 *
 * 这是一个 deep pure module：输入已经归一化、带 sequence 的 semantic envelope，
 * 输出可丢弃的 WorkbenchDocument。它不读取时钟、store、registry 或 IO；live、
 * restart、recovery 只要喂给同一组 envelopes，就得到同一份 document。
 */
import type { ContentPart } from './content/contentPartSchema.ts'
import { applyGoalEvents, applyPlanEvent, createEmptyGoalState, createEmptyPlanState, normalizeGoalSnapshot, type GoalSnapshot, type GoalState, type PlanState } from './plan/goalModel.ts'
import { applyLifecycleEvent, createEmptyLifecycleState, normalizeNormalizedError, type LifecycleState, type NormalizedError } from './lifecycle/lifecycleModel.ts'
import type {
  ActivityEvent,
  DiagnosticEvent,
  GoalEvent,
  InteractionEvent,
  LifecycleEvent,
  MessageEvent,
  PlanEvent,
  SessionEvent,
  ToolEvent,
  UsageEvent,
  WorkbenchEventEnvelope,
  WorkbenchSemanticEvent,
} from './events/workbenchEventSchema.ts'

export type WorkbenchTimelineKind =
  | 'message' | 'reasoning' | 'tool' | 'activity' | 'interaction'
  | 'session' | 'usage' | 'plan' | 'lifecycle' | 'diagnostic' | 'unknown' | 'assist'

export interface WorkbenchTimelineEntry {
  readonly id: string
  readonly sequence: number
  readonly eventId: string
  readonly kind: WorkbenchTimelineKind
  readonly status?: string
  readonly title?: string
  readonly summary?: string
  readonly data?: unknown
}

export interface WorkbenchMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'reasoning'
  readonly content: string
  readonly parts: readonly ContentPart[]
  readonly identity: WorkbenchEventEnvelope['identity']
  readonly source: WorkbenchEventEnvelope['source']
  readonly sequence: number
  readonly running: boolean
  readonly time: string
  /** C01：reasoning 完成/redacted 时记录的思考时长（首 delta → 终态 occurredAt）。 */
  readonly thoughtDurationMs?: number
  /** C01：provider 隐去推理标记——渲染层据此显示安全占位，不显示正文。 */
  readonly redacted?: boolean
  /** C01：隐去原因（provider 原样透传，缺失时 undefined）。 */
  readonly redactedReason?: string
  /** C01：内部字段——本段 reasoning 首个 delta 的 occurredAt（ms），用于终态计算 duration；不进渲染。 */
  readonly thoughtStartedAtMs?: number
}

export interface WorkbenchActivityNode {
  readonly id: string
  readonly kind: 'tool' | 'activity'
  /** Renderer semantic kind copied from normalized payload; never derived from provider raw. */
  readonly semanticKind?: string
  readonly title?: string
  readonly status: string
  readonly parentId?: string
  readonly orphan: boolean
  readonly data?: unknown
  readonly sequence: number
}

export interface WorkbenchInteraction {
  readonly id: string
  readonly status: 'requested' | 'resolved' | 'expired'
  readonly request?: unknown
  readonly response?: unknown
  readonly reason?: string
  readonly sequence: number
}

export interface WorkbenchSessionSurface {
  readonly status: string
  readonly stopReason?: string
  readonly model?: string
  readonly mode?: string
  readonly commands: readonly unknown[]
  readonly options: readonly unknown[]
  readonly usage?: unknown
}

export interface WorkbenchProjectionDiagnostic {
  readonly code: string
  readonly message: string
  readonly eventId: string
  readonly sequence: number
  readonly level: 'info' | 'warning' | 'error'
  readonly data?: unknown
}

export interface WorkbenchDocument {
  readonly sessionId: string
  readonly revision: number
  readonly appliedEventIds: readonly string[]
  readonly timeline: readonly WorkbenchTimelineEntry[]
  readonly messages: readonly WorkbenchMessage[]
  readonly activities: readonly WorkbenchActivityNode[]
  readonly interactions: readonly WorkbenchInteraction[]
  readonly session: WorkbenchSessionSurface
  readonly diagnostics: readonly WorkbenchProjectionDiagnostic[]
  readonly plan: PlanState
  readonly goal: GoalState
  /** C13：生命周期当前态 + 历史（恢复成功不删除历史事实） */
  readonly lifecycle: LifecycleState
  /** C13：system.error 级结构化错误（NormalizedError），与普通 notice 分离 */
  readonly systemErrors: readonly NormalizedError[]
}

export interface ProjectionResult {
  readonly document: WorkbenchDocument
  readonly diagnostics: readonly WorkbenchProjectionDiagnostic[]
}

export function createWorkbenchDocument(sessionId: string): WorkbenchDocument {
  return {
    sessionId,
    revision: 0,
    appliedEventIds: [],
    timeline: [],
    messages: [],
    activities: [],
    interactions: [],
    session: { status: 'idle', commands: [], options: [] },
    diagnostics: [],
    plan: createEmptyPlanState(sessionId),
    goal: createEmptyGoalState(),
    lifecycle: createEmptyLifecycleState(),
    systemErrors: [],
  }
}

export function reduceWorkbenchEvent(
  document: WorkbenchDocument,
  envelope: WorkbenchEventEnvelope,
): WorkbenchDocument {
  if (document.appliedEventIds.includes(envelope.eventId)) return document
  const timeline = insertBySequence(document.timeline, timelineEntry(envelope))
  let next: WorkbenchDocument = {
    ...document,
    revision: Math.max(document.revision, envelope.sequence),
    appliedEventIds: [...document.appliedEventIds, envelope.eventId],
    timeline,
  }
  next = reduceSemanticEvent(next, envelope)
  return refreshOrphans(next)
}

export function projectWorkbench(
  events: readonly WorkbenchEventEnvelope[],
  options: { readonly initialDocument?: WorkbenchDocument } = {},
): ProjectionResult {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
  const initial = options.initialDocument ?? createWorkbenchDocument(sorted[0]?.sessionId ?? '')
  const document = sorted.reduce(reduceWorkbenchEvent, initial)
  return { document, diagnostics: document.diagnostics }
}

export function selectTimeline(document: WorkbenchDocument): readonly WorkbenchTimelineEntry[] {
  return document.timeline
}

export function selectActivities(document: WorkbenchDocument): readonly WorkbenchActivityNode[] {
  return document.activities
}

export function selectInteractions(document: WorkbenchDocument): readonly WorkbenchInteraction[] {
  return document.interactions.filter(interaction => interaction.status === 'requested')
}

export function selectSessionSurface(document: WorkbenchDocument): WorkbenchSessionSurface {
  return document.session
}

/** C08：plan/goal slice 只读选择器。 */
export function selectPlan(document: WorkbenchDocument): PlanState {
  return document.plan
}

export function selectGoal(document: WorkbenchDocument): GoalSnapshot | undefined {
  return document.goal.current
}

/** C13：生命周期 slice 与 system error 只读选择器。 */
export function selectLifecycle(document: WorkbenchDocument): LifecycleState {
  return document.lifecycle
}

export function selectSystemErrors(document: WorkbenchDocument): readonly NormalizedError[] {
  return document.systemErrors
}

function reduceSemanticEvent(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope): WorkbenchDocument {
  const event = envelope.event
  switch (event.type) {
    case 'message.started':
    case 'message.delta':
    case 'message.completed':
      return reduceMessage(document, envelope, event)
    case 'reasoning.delta':
    case 'reasoning.completed':
    case 'reasoning.redacted':
      return reduceReasoning(document, envelope, event)
    case 'tool.started':
    case 'tool.progress':
    case 'tool.completed':
    case 'tool.failed':
      return reduceTool(document, envelope, event)
    case 'activity.started':
    case 'activity.progress':
    case 'activity.completed':
    case 'activity.failed':
    case 'activity.cancelled':
      return reduceActivity(document, envelope, event)
    case 'interaction.requested':
    case 'interaction.resolved':
    case 'interaction.expired':
      return reduceInteraction(document, envelope, event)
    case 'usage.updated':
    case 'budget.warning':
      return reduceUsage(document, envelope, event)
    case 'plan.replaced':
    case 'plan.entry-updated':
      return reducePlan(document, envelope, event)
    case 'goal.updated':
    case 'goal.cleared':
      return reduceGoal(document, envelope, event)
    case 'lifecycle.retrying':
    case 'lifecycle.compact-started':
    case 'lifecycle.compact-completed':
    case 'lifecycle.rewind-preview':
    case 'lifecycle.rewind-completed':
    case 'lifecycle.suspended':
    case 'lifecycle.recovered':
      return reduceLifecycle(document, event)
    case 'diagnostic.updated':
    case 'diagnostic.notice':
      return reduceDiagnostic(document, envelope, event)
    case 'session.started':
    case 'session.commands-updated':
    case 'session.config-updated':
    case 'session.model-updated':
    case 'session.mode-updated':
    case 'session.status-updated':
    case 'session.completed':
      return reduceSession(document, envelope, event)
    case 'event.unknown':
      return addDiagnostic(document, envelope, 'event.unknown', event.summary, 'warning', event)
    default:
      // assist.* 等未接 slice 的事件：只保留 timeline 条目，不产生副作用
      return document
  }
}

function reduceMessage(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: MessageEvent): WorkbenchDocument {
  const role = event.role === 'reasoning' ? 'assistant' : event.role === 'user' ? 'user' : 'assistant'
  const parts = event.parts ?? []
  const content = textFromParts(parts)
  const identityKey = identityKeyOf(envelope)
  const previous = document.messages.at(-1)
  // No identity means no safe message boundary guess. Keep deltas as separate
  // timeline messages; providers must supply messageId/turnId for aggregation.
  const append = previous && previous.role === role && identityKey !== '' && identityKey === identityKeyOf(previous)
  const messages = append
    ? [...document.messages.slice(0, -1), { ...previous, content: previous.content + content, parts: [...previous.parts, ...parts], sequence: envelope.sequence, running: event.type !== 'message.completed' }]
    : [...document.messages, { id: identityKey || envelope.eventId, role: role as WorkbenchMessage['role'], content, parts, identity: envelope.identity, source: envelope.source, sequence: envelope.sequence, running: event.type !== 'message.completed', time: envelope.occurredAt ?? envelope.recordedAt }]
  return { ...document, messages }
}

function reduceReasoning(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: WorkbenchSemanticEvent & { type: 'reasoning.delta' | 'reasoning.completed' | 'reasoning.redacted' }): WorkbenchDocument {
  const parts = event.parts ?? []
  // C01：redacted 时正文不保留原文（D06——raw 不进入 projection），只保留安全占位。
  const redacted = event.type === 'reasoning.redacted'
  const content = redacted ? '' : textFromParts(parts)
  const previous = document.messages.at(-1)
  const identityKey = identityKeyOf(envelope)
  const append = previous?.role === 'reasoning' && identityKey !== '' && identityKey === identityKeyOf(previous)
  // C01：时长 = 终态 occurredAt − 首个 delta occurredAt；append 段沿用首段时间基准。
  const terminalAt = Date.parse(envelope.occurredAt ?? envelope.recordedAt)
  const startedAt = append && previous?.thoughtStartedAtMs !== undefined
    ? previous.thoughtStartedAtMs
    : Date.parse(envelope.occurredAt ?? envelope.recordedAt)
  const durationMs = event.type === 'reasoning.delta'
    ? (append ? previous?.thoughtDurationMs : undefined)
    : Number.isFinite(terminalAt) && Number.isFinite(startedAt) ? Math.max(0, terminalAt - startedAt) : undefined
  const message: WorkbenchMessage = append
    ? {
        ...previous,
        content: redacted ? content : previous.content + content,
        parts: [...previous.parts, ...parts],
        sequence: envelope.sequence,
        running: false,
        ...(durationMs !== undefined ? { thoughtDurationMs: durationMs } : {}),
        ...(redacted ? { redacted: true } : {}),
        ...(event.reason !== undefined ? { redactedReason: event.reason } : {}),
      }
    : {
        id: identityKey || envelope.eventId,
        role: 'reasoning',
        content,
        parts,
        identity: envelope.identity,
        source: envelope.source,
        sequence: envelope.sequence,
        running: false,
        time: envelope.occurredAt ?? envelope.recordedAt,
        ...(durationMs !== undefined ? { thoughtDurationMs: durationMs } : { thoughtStartedAtMs: Number.isFinite(startedAt) ? startedAt : undefined }),
        ...(redacted ? { redacted: true } : {}),
        ...(event.reason !== undefined ? { redactedReason: event.reason } : {}),
      }
  return { ...document, messages: append ? [...document.messages.slice(0, -1), message] : [...document.messages, message] }
}

function reduceTool(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: ToolEvent): WorkbenchDocument {
  const tool = isRecord(event.tool) ? event.tool : {}
  const id = stringValue(tool.toolCallId) || envelope.identity.toolCallId || envelope.eventId
  const status = event.type === 'tool.started' ? 'running' : event.type === 'tool.failed' ? 'failed' : event.type === 'tool.completed' ? 'completed' : stringValue(tool.status) || 'progress'
  const node: WorkbenchActivityNode = {
    id, kind: 'tool', title: stringValue(tool.name) || stringValue(tool.title), status,
    ...(stringValue(tool.semanticKind) ? { semanticKind: stringValue(tool.semanticKind) } : {}),
    ...(stringValue(tool.parentActivityId) ? { parentId: stringValue(tool.parentActivityId) } : {}),
    orphan: false, data: event, sequence: envelope.sequence,
  }
  const activities = upsertActivity(document.activities, node)
  const timeline = updateTimeline(document.timeline, envelope.eventId, { status, title: node.title })
  return { ...document, activities, timeline }
}

function reduceActivity(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: ActivityEvent): WorkbenchDocument {
  const id = event.activityId || envelope.identity.taskId || envelope.eventId
  const activity = isRecord(event.activity) ? event.activity : {}
  const status = event.type.replace('activity.', '')
  return { ...document, activities: upsertActivity(document.activities, { id, kind: 'activity', title: stringValue(activity.title) || stringValue(activity.name), status, orphan: false, data: event, sequence: envelope.sequence }) }
}

function reduceInteraction(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: InteractionEvent): WorkbenchDocument {
  const id = event.interactionId || envelope.identity.interactionId || envelope.eventId
  const status = event.type === 'interaction.requested' ? 'requested' : event.type === 'interaction.expired' ? 'expired' : 'resolved'
  const interaction: WorkbenchInteraction = { id, status, request: event.request, response: event.response, reason: event.reason, sequence: envelope.sequence }
  return { ...document, interactions: [...document.interactions.filter(item => item.id !== id), interaction] }
}

function reduceUsage(document: WorkbenchDocument, _envelope: WorkbenchEventEnvelope, event: UsageEvent): WorkbenchDocument {
  return { ...document, session: { ...document.session, usage: event.usage ?? { used: event.used, limit: event.limit, threshold: event.threshold, percent: event.percent } } }
}

/** C08：plan 事件经 domain reducer 收敛进 document.plan；malformed entries 转可见诊断。 */
function reducePlan(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: PlanEvent): WorkbenchDocument {
  if (event.type === 'plan.replaced' && event.entries !== undefined && !Array.isArray(event.entries)) {
    return addDiagnostic(document, envelope, 'plan.malformed', 'plan.replaced entries is not an array; plan unchanged', 'warning', event.entries)
  }
  if (event.type === 'plan.entry-updated' && event.entry !== undefined && (typeof event.entry !== 'object' || event.entry === null || Array.isArray(event.entry))) {
    return addDiagnostic(document, envelope, 'plan.malformed', 'plan.entry-updated entry is not an object; plan unchanged', 'warning', event.entry)
  }
  const next = applyPlanEvent(document.plan, event)
  if (next === document.plan) return document
  return { ...document, plan: next }
}

function reduceGoal(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: GoalEvent): WorkbenchDocument {
  if (event.type === 'goal.updated' && event.goal !== undefined && normalizeGoalSnapshot(event.goal) === undefined) {
    return addDiagnostic(document, envelope, 'goal.malformed', 'goal.updated payload is not an object; goal unchanged', 'warning', event.goal)
  }
  const next = applyGoalEvents(document.goal, event)
  if (next === document.goal) return document
  return { ...document, goal: next }
}

function reduceSession(document: WorkbenchDocument, _envelope: WorkbenchEventEnvelope, event: SessionEvent): WorkbenchDocument {
  return {
    ...document,
    session: {
      ...document.session,
      status: event.type === 'session.completed' ? 'completed' : event.status ?? document.session.status,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      ...(event.model ? { model: event.model } : {}),
      ...(event.mode ? { mode: event.mode } : {}),
      ...(event.commands ? { commands: event.commands } : {}),
      ...(event.options ? { options: event.options } : {}),
    },
  }
}

/** C13：lifecycle 事件经 domain reducer 收敛；恢复成功不删除历史事实。 */
function reduceLifecycle(document: WorkbenchDocument, event: LifecycleEvent): WorkbenchDocument {
  const next = applyLifecycleEvent(document.lifecycle, event)
  if (next === document.lifecycle) return document
  return { ...document, lifecycle: next }
}

/**
 * C13：diagnostic 事件收敛。
 * - error 级 notice 进 systemErrors（结构化 NormalizedError），与 info/warning 分离；
 * - 全部 notice 仍进 diagnostics 时间线（历史事实不删）；
 * - turn.failed/provider.error 保持 A04 语义：收敛 running 消息并置 error 状态。
 */
function reduceDiagnostic(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: DiagnosticEvent): WorkbenchDocument {
  const level = event.level ?? 'info'
  const message = event.message ?? 'diagnostic event'
  const code = event.code ?? 'diagnostic.notice'
  const withError = level === 'error' && code !== 'turn.failed' && code !== 'provider.error'
    ? (() => {
        const normalized = normalizeNormalizedError({ userSummary: message, technicalMessage: message, code, sessionId: envelope.sessionId, eventId: envelope.eventId, recoverability: 'retry' })
        return normalized ? { ...document, systemErrors: [...document.systemErrors, normalized] } : document
      })()
    : document
  return addDiagnostic(withError, envelope, code, message, level, event)
}

function addDiagnostic(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, code: string, message: string, level: 'info' | 'warning' | 'error', data?: unknown): WorkbenchDocument {
  const diagnostic = { code, message, eventId: envelope.eventId, sequence: envelope.sequence, level, data }
  const failedTurn = code === 'turn.failed' || code === 'provider.error'
  return {
    ...document,
    ...(failedTurn ? {
      messages: document.messages.map(item => item.running ? { ...item, running: false } : item),
      session: { ...document.session, status: 'error' },
    } : {}),
    diagnostics: [...document.diagnostics, diagnostic],
    timeline: updateTimeline(document.timeline, envelope.eventId, { status: level, summary: message }),
  }
}

function refreshOrphans(document: WorkbenchDocument): WorkbenchDocument {
  const ids = new Set(document.activities.map(activity => activity.id))
  const activities = document.activities.map(activity => activity.parentId ? { ...activity, orphan: !ids.has(activity.parentId) } : activity)
  return activities === document.activities ? document : { ...document, activities }
}

function timelineEntry(envelope: WorkbenchEventEnvelope): WorkbenchTimelineEntry {
  const event = envelope.event
  const kind: WorkbenchTimelineKind = event.type.startsWith('message.') ? 'message'
    : event.type.startsWith('reasoning.') ? 'reasoning'
      : event.type.startsWith('tool.') ? 'tool'
        : event.type.startsWith('activity.') ? 'activity'
          : event.type.startsWith('interaction.') ? 'interaction'
            : event.type.startsWith('session.') ? 'session'
              : event.type.startsWith('usage.') || event.type === 'budget.warning' ? 'usage'
                : event.type.startsWith('diagnostic.') || event.type === 'event.unknown' ? (event.type === 'event.unknown' ? 'unknown' : 'diagnostic')
                  // C08/C13：plan/goal 同属 plan family；lifecycle 独立 kind（不再误判 assist）
                  : event.type.startsWith('plan.') || event.type.startsWith('goal.') ? 'plan'
                    : event.type.startsWith('lifecycle.') ? 'lifecycle' : 'assist'
  return { id: envelope.eventId, sequence: envelope.sequence, eventId: envelope.eventId, kind, data: event }
}

function insertBySequence<T extends { sequence: number }>(items: readonly T[], item: T): T[] {
  const next = [...items, item]
  next.sort((left, right) => left.sequence - right.sequence)
  return next
}

function updateTimeline(items: readonly WorkbenchTimelineEntry[], eventId: string, patch: Partial<WorkbenchTimelineEntry>): WorkbenchTimelineEntry[] {
  return items.map(item => item.eventId === eventId ? { ...item, ...patch } : item)
}

function upsertActivity(items: readonly WorkbenchActivityNode[], next: WorkbenchActivityNode): WorkbenchActivityNode[] {
  const index = items.findIndex(item => item.id === next.id)
  if (index < 0) return [...items, next]
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...next, parentId: next.parentId ?? item.parentId } : item)
}

function textFromParts(parts: readonly ContentPart[]): string {
  return parts.map(part => 'text' in part && typeof part.text === 'string' ? part.text : part.kind === 'unknown' ? part.summary : '').join('')
}

function identityKeyOf(value: WorkbenchEventEnvelope | WorkbenchMessage): string {
  const identity = value.identity
  return identity.messageId || identity.turnId || identity.toolCallId || identity.taskId || identity.interactionId || ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
