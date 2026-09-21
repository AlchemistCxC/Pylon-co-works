/**
 * A04：唯一 Workbench projector（读层）。
 *
 * 折叠计算已下沉 Rust/WASM（#220 / ADR-0018）：`projectWorkbench` /
 * `reduceWorkbenchEvent` 是 wasm 投影核（`src-tauri/pylon-compute/src/projector/**`，
 * 经 `infrastructure/compute/projectorCompute` 过界）的纯函数薄壳——文档入、
 * 文档出的契约不变，归约逻辑与折叠状态都在 wasm 侧，JS 文档由其产出物化。
 * 本文件保留 WorkbenchDocument 类型与只读选择器（消费者的读层），不读时钟、
 * store、registry 或 IO；live、restart、recovery 喂同一组 envelopes 得到同一份
 * document。
 */
import type { ContentPart } from './content/contentPartSchema.ts'
import { createEmptyGoalState, createEmptyPlanState, type GoalSnapshot, type GoalState, type PlanState } from './plan/goalModel.ts'
import { createEmptyLifecycleState, type LifecycleState, type NormalizedError } from './lifecycle/lifecycleModel.ts'
import type { ExtensionEvent, WorkbenchEventEnvelope } from './events/workbenchEventSchema.ts'
import {
  EMPTY_ASSIST_SNAPSHOT,
  type AssistSnapshot,
  type SessionCommand,
  type SessionConfigOption,
  type UsageSnapshot,
} from './session/sessionSurface.ts'
import { projectWorkbenchFold, reduceWorkbenchFold } from '../../infrastructure/compute/projectorCompute.ts'

export type WorkbenchTimelineKind =
  | 'message' | 'reasoning' | 'tool' | 'activity' | 'interaction'
  | 'session' | 'usage' | 'plan' | 'lifecycle' | 'diagnostic' | 'extension' | 'unknown' | 'assist'

export interface WorkbenchTimelineEntry {
  readonly id: string
  readonly sequence: number
  readonly eventId: string
  readonly kind: WorkbenchTimelineKind
  readonly status?: string
  readonly title?: string
  readonly summary?: string
  /** First semantic occurrence of an activity that splits adjacent text streams. */
  readonly streamBoundary?: boolean
  readonly data?: unknown
}

export interface WorkbenchMessage {
  /** Session-scoped render key. Never reuse a provider message/turn id as a row key. */
  readonly id: string
  /** Replay-stable identity of this projected text segment (the opening canonical event id). */
  readonly segmentId: string
  readonly role: 'user' | 'assistant' | 'reasoning'
  readonly content: string
  readonly parts: readonly ContentPart[]
  readonly identity: WorkbenchEventEnvelope['identity']
  readonly source: WorkbenchEventEnvelope['source']
  /** Temporary local echo marker used only until the authoritative user row arrives. */
  readonly optimistic?: boolean
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

/** Canonical negotiated extension event projected into the disposable document. */
export interface WorkbenchExtensionNode {
  readonly id: string
  readonly kind: ExtensionEvent['kind']
  readonly payload: ExtensionEvent['payload']
  readonly fallback: ExtensionEvent['fallback']
  readonly identity: WorkbenchEventEnvelope['identity']
  readonly source: WorkbenchEventEnvelope['source']
  readonly provenance: WorkbenchEventEnvelope['provenance']
  readonly sequence: number
  readonly time: string
}

export interface WorkbenchDocument {
  readonly sessionId: string
  readonly revision: number
  readonly appliedEventIds: readonly string[]
  /** #81 L2：journal 权威覆盖区间（升序、合并且互不重叠）。携带 coverage 的
   * journal 信封以区间覆盖做幂等（单元/批量行与逐 chunk 行粒度不同，id 集合
   * 无法对齐）；不带 coverage 的信封（optimistic/session-response）保持
   * appliedEventIds 幂等，行为不变。 */
  readonly appliedRanges: readonly (readonly [number, number])[]
  readonly timeline: readonly WorkbenchTimelineEntry[]
  readonly messages: readonly WorkbenchMessage[]
  readonly activities: readonly WorkbenchActivityNode[]
  readonly interactions: readonly WorkbenchInteraction[]
  readonly extensions: readonly WorkbenchExtensionNode[]
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

/** JS 侧空文档形状（折叠状态本体在 wasm 投影核；运行时 legacy 派生与预览夹具也用它）。 */
export function createWorkbenchDocument(sessionId: string): WorkbenchDocument {
  return {
    sessionId,
    revision: 0,
    appliedEventIds: [],
    appliedRanges: [],
    timeline: [],
    messages: [],
    activities: [],
    interactions: [],
    extensions: [],
    session: { status: 'idle', commands: [], options: [] },
    assist: EMPTY_ASSIST_SNAPSHOT,
    diagnostics: [],
    plan: createEmptyPlanState(sessionId),
    goal: createEmptyGoalState(),
    lifecycle: createEmptyLifecycleState(),
    systemErrors: [],
  }
}

/**
 * 批量折叠（回放按页合批的落点）：一页事件一帧过界，由 wasm 投影核归约。
 * 纯函数契约保留——`initialDocument` 是本层池化产出的文档时复用同一投影核实例
 * （链式折叠零重建）；语义与逐事件 `reduceWorkbenchEvent` 一致。
 */
export function projectWorkbench(
  events: readonly WorkbenchEventEnvelope[],
  options: { readonly initialDocument?: WorkbenchDocument } = {},
): ProjectionResult {
  return projectWorkbenchFold(events, options)
}

/** 单事件折叠（live 逐帧到达的自然粒度；幂等判据在 wasm 侧，同一 eventId/覆盖区间不重复入账）。 */
export function reduceWorkbenchEvent(
  document: WorkbenchDocument,
  envelope: WorkbenchEventEnvelope,
): WorkbenchDocument {
  return reduceWorkbenchFold(document, envelope)
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

const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

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

export function selectExtensions(document: WorkbenchDocument): readonly WorkbenchExtensionNode[] {
  return document.extensions
}
