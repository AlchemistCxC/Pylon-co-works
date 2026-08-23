/**
 * A04：唯一 Workbench projector。
 *
 * 这是一个 deep pure module：输入已经归一化、带 sequence 的 semantic envelope，
 * 输出可丢弃的 WorkbenchDocument。它不读取时钟、store、registry 或 IO；live、
 * restart、recovery 只要喂给同一组 envelopes，就得到同一份 document。
 */
import { createUnknownContentPart, parseContentPart, type ContentPart } from './content/contentPartSchema.ts'
import { applyGoalEvents, applyPlanEvent, createEmptyGoalState, createEmptyPlanState, normalizeGoalSnapshot, type GoalSnapshot, type GoalState, type PlanState } from './plan/goalModel.ts'
import { applyLifecycleEvent, createEmptyLifecycleState, normalizeNormalizedError, type LifecycleState, type NormalizedError } from './lifecycle/lifecycleModel.ts'
import { isActivityStatus } from './events/workbenchEventSchema.ts'
import type {
  ActivityEvent,
  AssistEvent,
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
import {
  EMPTY_ASSIST_SNAPSHOT,
  normalizeBudgetSnapshot,
  normalizeSessionCommands,
  normalizeSessionConfigOptions,
  normalizeUsageSnapshot,
  type AssistSnapshot,
  type SessionCommand,
  type SessionConfigOption,
  type UsageSnapshot,
} from './session/sessionSurface.ts'

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
  /** Provider-neutral activity family (for example process/background-task). */
  readonly activityKind?: string
  readonly title?: string
  readonly status: string
  readonly parentId?: string
  /** C09：创建该节点的 normalized agent identity；不从 parent/title 推断。 */
  readonly sourceAgentId?: string
  readonly description?: string
  readonly startedAt?: string
  readonly completedAt?: string
  /** C07：后台执行身份；仅来自 normalized activity payload/patch。 */
  readonly processId?: string
  readonly sessionId?: string
  /** C04：canonical machine name（_meta.pylon.toolName 优先的归一结果）。 */
  readonly canonicalName?: string
  /** C04：normalized input（renderer 消费字段；rawInput 只作审计兼容留在 data/rawOutput 侧）。 */
  readonly input?: unknown
  /** C04：normalized locations（文件/行范围数组）。 */
  readonly locations?: unknown
  /** C04：最近一次 provider-neutral progress 快照；终态到达后仍保留。 */
  readonly progress?: unknown
  /** C04：provider-neutral action（read/write/execute/…）。 */
  readonly action?: string
  /** C04：capability snapshot（如 ['fs','mcp','dynamic-schema']）。 */
  readonly capabilities?: unknown
  /** C04：父工具调用 id（子代理/嵌套工具关系，semantic parent）。 */
  readonly parentToolCallId?: string
  /** C04：终态耗时（ms），由 completed/redacted 终态事件携带。 */
  readonly durationMs?: number
  /** C04：failed/cancelled 的结构化错误摘要。 */
  readonly error?: NormalizedError
  /** C04：result parts（ContentPart 数组，renderer 递归渲染）。 */
  readonly parts?: unknown
  /** C04：审计兼容原始输出（不进 UI 主路径）。 */
  readonly rawOutput?: unknown
  /** C04：wire 原始工具名（generic 卡显示；与展示 title 分离）。 */
  readonly providerName?: string
  /** C04：审计兼容原始 input（不进 UI 主路径）。 */
  readonly rawInput?: unknown
  /** C04：wire kind（ACP kind 字段直通）。 */
  readonly toolKindWire?: string
  /** C04：本地化显示标题（title 直通；不作为身份）。 */
  readonly displayName?: string
  /** C07：activity terminal result and cancellation reason remain separate from message history. */
  readonly result?: unknown
  /** C10：progress patch termination evidence; never inferred from transcript text. */
  readonly killed?: boolean
  readonly timeout?: boolean
  /** C09：schema-validated activity output consumed by renderers. */
  readonly output?: readonly ContentPart[]
  readonly reason?: string
  readonly provenance?: WorkbenchEventEnvelope['provenance']
  /** C09：子代理层级深度（来自 normalized payload，不从文本猜）。 */
  readonly depth?: number
  /** C09：子代理角色（如 explorer/reviewer）。 */
  readonly role?: string
  /** C09：执行模型与 provider（显示用，非身份）。 */
  readonly model?: string
  readonly provider?: string
  /** C09：目标/prompt 摘要。 */
  readonly goal?: string
  /** C09：usage/cost 与文件清单等聚合指标（JsonValue 宽容）。 */
  readonly usage?: unknown
  readonly metrics?: unknown
  readonly files?: unknown
  /** C09：local/remote/background/worktree/team 等 provider-neutral execution metadata。 */
  readonly execution?: unknown
  readonly tools?: unknown
  readonly tasks?: unknown
  readonly metadata?: unknown
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
  readonly commands: readonly SessionCommand[]
  readonly options: readonly SessionConfigOption[]
  readonly usage?: UsageSnapshot
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
  readonly assist: AssistSnapshot
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
    assist: EMPTY_ASSIST_SNAPSHOT,
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
  // C12：secret-bearing interaction 事件在进入任何投影面（timeline.data、interactions）前统一剥敏——
  // journal 投影的 timeline 与 document.interactions 共享同一脱敏结果
  const effective: WorkbenchEventEnvelope = envelope.event.type.startsWith('interaction.')
    ? { ...envelope, event: redactInteractionEvent(envelope.event as unknown as Record<string, unknown>) } as unknown as WorkbenchEventEnvelope
    : envelope
  const timeline = insertBySequence(document.timeline, timelineEntry(effective))
  let next: WorkbenchDocument = {
    ...document,
    revision: Math.max(document.revision, envelope.sequence),
    appliedEventIds: [...document.appliedEventIds, envelope.eventId],
    timeline,
  }
  next = reduceSemanticEvent(next, effective)
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

/** C09：按 identity parent edge 派生稳定展示顺序；journal/document 本身保持原序。 */
export function selectActivityDisplayOrder(document: WorkbenchDocument): readonly WorkbenchActivityNode[] {
  const nodes = document.activities
  if (nodes.length < 2) return nodes
  const byId = new Map(nodes.map(node => [node.id, node]))
  const children = new Map<string, WorkbenchActivityNode[]>()
  const roots: WorkbenchActivityNode[] = []
  for (const node of nodes) {
    if (!node.parentId || node.parentId === node.id || !byId.has(node.parentId)) {
      roots.push(node)
      continue
    }
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const ordered: WorkbenchActivityNode[] = []
  const visited = new Set<string>()
  const appendTree = (root: WorkbenchActivityNode) => {
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (visited.has(node.id)) continue
      visited.add(node.id)
      ordered.push(node)
      const descendants = children.get(node.id)
      if (descendants) for (let index = descendants.length - 1; index >= 0; index -= 1) stack.push(descendants[index])
    }
  }
  for (const root of roots) appendTree(root)
  // Cycles have no root; append them deterministically without losing evidence.
  for (const node of nodes) appendTree(node)
  return ordered
}

/** C11：全部 interaction 列表（requested/resolved/expired 均可见，供历史审计与 fallback）。 */
export function selectInteractions(document: WorkbenchDocument): readonly WorkbenchInteraction[] {
  return document.interactions
}
/** C11：待处理 interaction 队列（renderer 卡片消费；重复 response 幂等由 reducer 保证）。 */
export function selectPendingInteractions(document: WorkbenchDocument): readonly WorkbenchInteraction[] {
  return document.interactions.filter(interaction => interaction.status === 'requested')
}

/** C04：工具调用 provider-neutral snapshot（renderer 消费的唯一形态）。 */
export interface ToolInvocationSnapshot {
  readonly id: string
  /** 展示名（wire title 直通；缺失时 undefined，由 generic 卡显示 provider name）。 */
  readonly title?: string
  /** canonical machine name（_meta.pylon.toolName 优先）。 */
  readonly canonicalName?: string
  /** wire 原始 name（generic 卡的 provider name 显示）。 */
  readonly name?: string
  readonly semanticKind?: string
  readonly kind?: string
  readonly action?: string
  readonly capabilities?: unknown
  /** normalized input（renderer 消费字段）。 */
  readonly input?: unknown
  /** 审计兼容原始 input（不进 UI 主路径）。 */
  readonly rawInput?: unknown
  readonly locations?: unknown
  readonly status?: string
  readonly progress?: unknown
  readonly parentToolCallId?: string
  readonly result?: {
    readonly status?: string
    readonly parts?: unknown
    readonly rawOutput?: unknown
    readonly error?: NormalizedError
    readonly durationMs?: number
  }
}

/**
 * C04 架构补全：从 document activities 收窄出 typed 工具调用快照。
 * 缺字段保持 undefined（不伪造空值/零值）；未知 id 返回 null。
 */
export function toolInvocationSnapshot(document: WorkbenchDocument, toolCallId: string): ToolInvocationSnapshot | null {
  const node = document.activities.find(entry => entry.id === toolCallId && entry.kind === 'tool')
  if (!node) return null
  // C04：result 只在真实结果到达后存在——running 中不伪造 {status:'running'}
  const terminalOrHasOutput = TERMINAL_TOOL_STATUSES.has(node.status) || node.parts !== undefined || node.rawOutput !== undefined || node.error !== undefined
  const resultFields = terminalOrHasOutput ? {
    ...(node.status !== undefined ? { status: node.status } : {}),
    ...(node.parts !== undefined ? { parts: node.parts } : {}),
    ...(node.rawOutput !== undefined ? { rawOutput: node.rawOutput } : {}),
    ...(node.error !== undefined ? { error: node.error } : {}),
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
  } : {}
  // C04：title/canonicalName/name 三者语义分离——title 是展示标题，canonicalName 是归一机器名，
  // name 是 wire 原始名。node.title 在 reduceTool 里由 tool.name || tool.title 回填，
  // 因此 wire name 从原始事件（data.event.tool）取回，不与展示标题混淆。
  return Object.freeze({
    id: node.id,
    ...(node.displayName !== undefined ? { title: node.displayName } : node.title !== undefined ? { title: node.title } : {}),
    ...(node.canonicalName !== undefined ? { canonicalName: node.canonicalName } : {}),
    ...(node.providerName !== undefined ? { name: node.providerName } : {}),
    ...(node.semanticKind !== undefined ? { semanticKind: node.semanticKind } : {}),
    ...(node.toolKindWire !== undefined ? { kind: node.toolKindWire } : {}),
    ...(node.action !== undefined ? { action: node.action } : {}),
    ...(node.capabilities !== undefined ? { capabilities: node.capabilities } : {}),
    ...(node.input !== undefined ? { input: node.input } : {}),
    ...(node.rawInput !== undefined ? { rawInput: node.rawInput } : {}),
    ...(node.locations !== undefined ? { locations: node.locations } : {}),
    ...(node.status !== undefined ? { status: node.status } : {}),
    ...(node.progress !== undefined ? { progress: node.progress } : {}),
    ...(node.parentToolCallId !== undefined ? { parentToolCallId: node.parentToolCallId } : {}),
    ...(Object.keys(resultFields).length > 0 ? { result: resultFields } : {}),
  })
}

export function selectSessionSurface(document: WorkbenchDocument): WorkbenchSessionSurface {
  return document.session
}

export function selectAssist(document: WorkbenchDocument): AssistSnapshot {
  return document.assist
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
    case 'assist.prediction':
    case 'assist.file-suggestions':
    case 'assist.queued-command':
      return reduceAssist(document, event)
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
  // C01：terminal 是吸收态——迟到 delta/重复 completion 不得复活或改写首次终态。
  // redaction 是唯一可继续收紧的迁移：即使 completed 已到，也必须清除可见正文与历史 parts。
  if (append && previous && !previous.running) {
    if (redacted && !previous.redacted) {
      const secured: WorkbenchMessage = {
        ...previous,
        content: '',
        parts,
        sequence: envelope.sequence,
        redacted: true,
        ...(event.reason !== undefined ? { redactedReason: event.reason } : {}),
      }
      return { ...document, messages: [...document.messages.slice(0, -1), secured] }
    }
    return document
  }
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
        parts: redacted ? parts : [...previous.parts, ...parts],
        sequence: envelope.sequence,
        running: event.type === 'reasoning.delta',
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
        running: event.type === 'reasoning.delta',
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
  const status = toolLifecycleStatus(event.type, stringValue(tool.status) || 'progress')
  const normalizedToolError = tool.error !== undefined ? normalizeNormalizedError(tool.error) : undefined
  // C04 DIC-C04-01/架构补全：canonical 字段自 normalized payload 收窄进 activity node，
  // renderer 经 toolInvocationSnapshot 消费，不再读 provider raw。
  const previous = document.activities.find(node => node.id === id && node.kind === 'tool')
  const node: WorkbenchActivityNode = {
    // C04/DIC：node.title 是工具身份（machine name，_meta.pylon.toolName 优先）；
    // 本地化 title 只进 snapshot.title 供显示，不作为身份。
    id, kind: 'tool', title: stringValue(tool.name) || previous?.title || (stringValue(tool.name) || undefined), status,
    ...(stringValue(tool.semanticKind) ? { semanticKind: stringValue(tool.semanticKind) } : previous?.semanticKind ? { semanticKind: previous.semanticKind } : {}),
    ...(stringValue(tool.parentToolUseId) ? { parentToolCallId: stringValue(tool.parentToolUseId) } : previous?.parentToolCallId ? { parentToolCallId: previous.parentToolCallId } : {}),
    ...(stringValue(tool.parentActivityId) ? { parentId: stringValue(tool.parentActivityId) } : previous?.parentId ? { parentId: previous.parentId } : {}),
    ...(stringValue(tool.canonicalName) ? { canonicalName: stringValue(tool.canonicalName) } : previous?.canonicalName ? { canonicalName: previous.canonicalName } : {}),
    ...(stringValue(tool.kind) ? { toolKindWire: stringValue(tool.kind) } : previous?.toolKindWire ? { toolKindWire: previous.toolKindWire } : {}),
    ...(stringValue(tool.title) ? { displayName: stringValue(tool.title) } : previous?.displayName ? { displayName: previous.displayName } : {}),
    ...(tool.input !== undefined ? { input: jsonSnapshot(tool.input) } : {}),
    ...(Array.isArray(tool.locations) ? { locations: jsonSnapshot(tool.locations) } : {}),
    ...(tool.progress !== undefined ? { progress: jsonSnapshot(tool.progress) } : {}),
    ...(stringValue(tool.action) ? { action: stringValue(tool.action) } : {}),
    ...(Array.isArray(tool.capabilities) ? { capabilities: jsonSnapshot(tool.capabilities) } : {}),
    ...(Number.isFinite(Number(tool.durationMs)) ? { durationMs: Number(tool.durationMs) } : {}),
    ...(normalizedToolError ? { error: normalizedToolError } : {}),
    ...(Array.isArray(tool.parts) ? { parts: jsonSnapshot(tool.parts) } : {}),
    ...(tool.rawOutput !== undefined ? { rawOutput: jsonSnapshot(tool.rawOutput) } : {}),
    ...(stringValue(tool.providerName) ? { providerName: stringValue(tool.providerName) }
      : stringValue(tool.name) ? { providerName: stringValue(tool.name) }
        : previous?.providerName ? { providerName: previous.providerName } : {}),
    ...(tool.rawInput !== undefined ? { rawInput: jsonSnapshot(tool.rawInput) } : previous?.rawInput !== undefined ? { rawInput: previous.rawInput } : {}),
    orphan: false,
    // C04 终态幂等：终态一旦写入，迟到的 progress 不回退状态
    data: event, sequence: envelope.sequence,
  }
  const merged = mergeToolActivity(previous, node)
  const activities = upsertActivity(document.activities, merged ?? node)
  const timeline = updateTimeline(document.timeline, envelope.eventId, { status: merged?.status ?? status, title: merged?.title ?? node.title })
  return { ...document, activities, timeline }
}

/** 工具生命周期状态机：started→running、progress 保持、终态幂等。 */
function toolLifecycleStatus(eventType: string, payloadStatus: string): string {
  if (eventType === 'tool.started') return 'running'
  if (eventType === 'tool.failed') return 'failed'
  if (eventType === 'tool.completed') return 'completed'
  if (eventType === 'tool.cancelled') return 'cancelled'
  return payloadStatus || 'progress'
}

const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

/**
 * C04 终态幂等合并：previous 已是终态时，迟到事件只补充字段不回退状态
 * （failed 不伪装 completed，progress 不复活已结束的调用）。
 */
function mergeToolActivity(previous: WorkbenchActivityNode | undefined, next: WorkbenchActivityNode): WorkbenchActivityNode | null {
  if (!previous) return null
  const previousTerminal = TERMINAL_TOOL_STATUSES.has(previous.status)
  if (previousTerminal) {
    // 首个终态吸收所有迟到事件；仅补齐此前缺失的 identity/evidence，
    // 不允许 completed/failed 互相改写，也不让 progress 复活。
    const filled: WorkbenchActivityNode = { ...previous }
    for (const key of [
      'semanticKind', 'title', 'parentId', 'canonicalName', 'input', 'locations', 'progress',
      'action', 'capabilities', 'parentToolCallId', 'durationMs', 'error', 'parts', 'rawOutput',
      'providerName', 'rawInput', 'toolKindWire', 'displayName',
    ] as const) {
      const value = next[key]
      if (value !== undefined && filled[key] === undefined) {
        (filled as unknown as Record<string, unknown>)[key] = value
      }
    }
    return filled
  }
  return next
}

function reduceActivity(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: ActivityEvent): WorkbenchDocument {
  const id = event.activityId || envelope.identity.taskId || envelope.eventId
  const activity = isRecord(event.activity) ? event.activity : {}
  const patch = isRecord(event.patch) ? event.patch : {}
  const result = isRecord(event.result) ? event.result : undefined
  const previous = document.activities.find(item => item.id === id && item.kind === 'activity')
  const status = activityLifecycleStatus(event.type, patch, previous)
  const activityKind = stringValue(activity.kind) ?? stringValue(patch.kind) ?? previous?.activityKind
  const semanticKind = stringValue(activity.semanticKind) ?? stringValue(patch.semanticKind) ?? previous?.semanticKind
    ?? (activityKind === 'process' || activityKind === 'background-task'
      // C09：子代理/委派/团队家族同样从 wire family 派生渲染语义
      || activityKind === 'subagent' || activityKind === 'delegation' || activityKind === 'team'
      // C10：后台任务与工作流家族（workflow-phase/agent 经 parentId relation 挂接）
      || activityKind === 'workflow' || activityKind === 'workflow-phase' || activityKind === 'workflow-agent'
      ? `activity.${activityKind}` : undefined)
  const sourceParts = result?.output ?? result?.parts ?? patch.output ?? patch.parts ?? activity.output ?? activity.parts
  const isC09Activity = activityKind === 'subagent' || activityKind === 'delegation' || activityKind === 'team'
  const isC10Activity = activityKind === 'background-task' || activityKind === 'workflow'
    || activityKind === 'workflow-phase' || activityKind === 'workflow-agent'
  const typedPartsFamily = activityKind === 'process' || isC10Activity || isC09Activity
  const strictParts = typedPartsFamily || semanticKind === 'activity.process'
    ? narrowActivityParts(sourceParts, id, envelope, activityKind ?? semanticKind?.replace(/^activity\./, '') ?? 'activity')
    : undefined
  const narrowedParts = strictParts ?? { parts: jsonSnapshot(sourceParts), diagnostics: [] }
  const parts = narrowedParts.parts ?? previous?.parts
  const output = isC09Activity || isC10Activity ? strictParts?.parts ?? previous?.output : previous?.output
  const error = event.error !== undefined
    ? normalizeNormalizedError(event.error)
    : result?.error !== undefined
      ? normalizeNormalizedError(result.error)
      : patch.error !== undefined
        ? normalizeNormalizedError(patch.error)
        : previous?.error
  const killed = typeof patch.killed === 'boolean' ? patch.killed : previous?.killed
  const timeout = typeof patch.timeout === 'boolean' ? patch.timeout : previous?.timeout
  const next: WorkbenchActivityNode = {
    id,
    kind: 'activity',
    status,
    orphan: false,
    sequence: envelope.sequence,
    ...(semanticKind ? { semanticKind } : {}),
    ...(activityKind ? { activityKind } : {}),
    ...(stringValue(activity.title) ?? stringValue(activity.name) ?? stringValue(patch.title) ?? previous?.title
      ? { title: stringValue(activity.title) ?? stringValue(activity.name) ?? stringValue(patch.title) ?? previous?.title }
      : {}),
    ...(stringValue(activity.parentId) ?? stringValue(patch.parentId) ?? previous?.parentId
      ? { parentId: stringValue(activity.parentId) ?? stringValue(patch.parentId) ?? previous?.parentId }
      : {}),
    ...(stringValue(activity.processId) ?? stringValue(patch.processId) ?? previous?.processId
      ? { processId: stringValue(activity.processId) ?? stringValue(patch.processId) ?? previous?.processId }
      : {}),
    ...(stringValue(activity.sessionId) ?? stringValue(patch.sessionId) ?? previous?.sessionId
      ? { sessionId: stringValue(activity.sessionId) ?? stringValue(patch.sessionId) ?? previous?.sessionId }
      : {}),
    ...(patch.progress !== undefined ? { progress: jsonSnapshot(patch.progress) } : previous?.progress !== undefined ? { progress: previous.progress } : {}),
    ...(parts !== undefined ? { parts } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(event.result !== undefined
      ? { result: jsonSnapshot(event.result) }
      : patch.result !== undefined
        ? { result: jsonSnapshot(patch.result) }
        : previous?.result !== undefined ? { result: previous.result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(killed !== undefined ? { killed } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(stringValue(event.reason) ?? previous?.reason ? { reason: stringValue(event.reason) ?? previous?.reason } : {}),
    // C09：子代理/委派/团队 rich 字段——跨事件累积（当前缺失保留前值），缺失稳定降级为 undefined
    ...c09RichFields(activity, patch, result, previous),
    provenance: envelope.provenance,
  }
  const merged = mergeActivityTerminal(previous, next)
  const projected = { ...document, activities: upsertActivity(document.activities, merged ?? next) }
  return narrowedParts.diagnostics.length > 0
    ? { ...projected, diagnostics: [...projected.diagnostics, ...narrowedParts.diagnostics] }
    : projected
}

/** Provider-neutral activity lifecycle: progress is an update, not a state. */
function activityLifecycleStatus(
  eventType: ActivityEvent['type'],
  patch: Record<string, unknown>,
  previous: WorkbenchActivityNode | undefined,
): string {
  if (eventType === 'activity.started') return 'running'
  if (eventType === 'activity.progress') {
    const patchStatus = stringValue(patch.status)
    if (patchStatus !== undefined) return isActivityStatus(patchStatus) ? patchStatus : 'unknown'
    return previous?.status ?? 'running'
  }
  return eventType.replace('activity.', '')
}

function narrowActivityParts(
  value: unknown,
  activityId: string,
  envelope: WorkbenchEventEnvelope,
  activityFamily: string,
): { parts?: readonly ContentPart[]; diagnostics: readonly WorkbenchProjectionDiagnostic[] } {
  if (value === undefined) return { diagnostics: [] }
  const sourceParts = Array.isArray(value) ? value : [value]
  const parts: ContentPart[] = []
  const diagnostics: WorkbenchProjectionDiagnostic[] = []
  sourceParts.forEach((part, partIndex) => {
    const parsed = parseContentPart(part)
    if (parsed.ok) {
      parts.push(parsed.value)
      return
    }
    const originalType = isRecord(part) && typeof part.kind === 'string' ? part.kind : 'malformed'
    parts.push(createUnknownContentPart(originalType, part))
    diagnostics.push({
      code: `activity.${activityFamily}.part-malformed`,
      message: `${activityFamily} activity part ${partIndex} failed content schema validation`,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      level: 'warning',
      data: { activityId, partIndex, issues: parsed.issues },
    })
  })
  return { parts, diagnostics }
}

/** C09：子代理/委派/团队 rich 字段收窄——只认 normalized activity/patch，缺失即 undefined（不猜）。 */
function c09RichFields(
  activity: Record<string, unknown>,
  patch: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  previous: WorkbenchActivityNode | undefined,
): Partial<WorkbenchActivityNode> {
  const pickString = (key: string): string | undefined =>
    stringValue(activity[key]) ?? stringValue(patch[key]) ?? stringValue(result?.[key])
    ?? previous?.[key as keyof WorkbenchActivityNode] as string | undefined
  const pickNumber = (key: string): number | undefined => {
    const value = activity[key] ?? patch[key]
    return (typeof value === 'number' && Number.isFinite(value)) ? value : undefined
  }
  const pickValue = (key: string): unknown | undefined =>
    jsonSnapshot(activity[key] ?? patch[key] ?? result?.[key])
    ?? (previous?.[key as keyof WorkbenchActivityNode] as unknown | undefined)
  const fields: Partial<Record<keyof WorkbenchActivityNode, unknown>> = {
    sourceAgentId: pickString('sourceAgentId'),
    description: pickString('description'),
    startedAt: pickString('startedAt'),
    completedAt: pickString('completedAt'),
    depth: pickNumber('depth'),
    role: pickString('role'),
    model: pickString('model'),
    provider: pickString('provider'),
    goal: pickString('goal'),
    usage: pickValue('usage'),
    metrics: pickValue('metrics'),
    capabilities: pickValue('capabilities'),
    files: pickValue('files'),
    execution: pickValue('execution'),
    tools: pickValue('tools'),
    tasks: pickValue('tasks'),
    metadata: pickValue('metadata'),
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value
  }
  return out as unknown as Partial<WorkbenchActivityNode>
}

/** C09 活动终态幂等：与 mergeToolActivity 同构——终态后迟到事件仅补缺字段，不回退状态。 */
const ACTIVITY_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed', 'failed', 'interrupted', 'cancelled', 'timeout',
])

function mergeActivityTerminal(previous: WorkbenchActivityNode | undefined, next: WorkbenchActivityNode): WorkbenchActivityNode | null {
  if (!previous || !ACTIVITY_TERMINAL_STATUSES.has(previous.status)) return null
  const filled: Record<string, unknown> = { ...previous }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue
    if (filled[key] === undefined) { filled[key] = value; continue }
    // 终态保护：status 不被迟到事件改写；progress 保持首个终态时刻的快照
    if (key === 'status') continue
  }
  filled.orphan = next.orphan && Boolean(previous.parentId)
  return filled as unknown as WorkbenchActivityNode
}

/** C12：secret-bearing interaction 的脱敏键清单——命中值永不落 journal/document/diagnostic。 */
const SENSITIVE_REQUEST_KEYS: ReadonlySet<string> = new Set(['password', 'secret', 'value', 'token', 'accesstoken', 'refreshtoken', 'clientsecret', 'apikey', 'authorization', 'credential', 'cookie'])
/** OAuth URL scheme 白名单（C12 步骤 2）；其余 scheme 的 url 字段整体剥除。 */
const OAUTH_URL_PATTERN = /^https:\/\/|^http:\/\/localhost/

/** C12：事件级剥敏——request/response 双字段；envelope.event 与 document.interactions 共享同一结果。 */
function redactInteractionEvent<T extends Record<string, unknown>>(event: T): T {
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
function reduceInteraction(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, event: InteractionEvent): WorkbenchDocument {
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

function reduceUsage(document: WorkbenchDocument, _envelope: WorkbenchEventEnvelope, event: UsageEvent): WorkbenchDocument {
  if (event.type === 'budget.warning') {
    const budget = normalizeBudgetSnapshot(event, document.session.usage?.budget)
    return { ...document, session: { ...document.session, usage: { ...document.session.usage, budget } } }
  }
  const normalized = normalizeUsageSnapshot(event.usage, document.session.usage)
  const next = { ...document, session: { ...document.session, usage: normalized.value } }
  return normalized.invalidFields.reduce<WorkbenchDocument>((current, field) => addDiagnostic(current, _envelope,
    'session.usage.invalid-field', `usage field ${field} is invalid; retained in raw`, 'warning', event.usage), next)
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
      ...(event.commands ? { commands: normalizeSessionCommands(event.commands) } : {}),
      ...(event.options ? { options: normalizeSessionConfigOptions(event.options) } : {}),
    },
  }
}

function reduceAssist(document: WorkbenchDocument, event: AssistEvent): WorkbenchDocument {
  if (event.type === 'assist.prediction') {
    return { ...document, assist: { ...document.assist, prediction: {
      ...(event.placeholder ? { placeholder: event.placeholder } : {}),
      actions: Object.freeze([...(event.actions ?? [])]),
    } } }
  }
  if (event.type === 'assist.file-suggestions') {
    return { ...document, assist: { ...document.assist, files: Object.freeze([...(event.files ?? [])]) } }
  }
  return { ...document, assist: { ...document.assist, ...(event.command ? { queuedCommand: event.command } : {}) } }
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

/** C04：把 normalized 字段冻结为可安全持有的 Json 快照（非 JSON 值降级为 undefined）。 */
function jsonSnapshot(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return structuredClone(value)
  } catch {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return undefined
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
