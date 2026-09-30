/**
 * A04 projector · 类型与词汇层（#486 项2 自单文件四分：类型 / reducer / selector /
 * 诊断预算+载荷收窄；本文件是叶子层，只被其余三件与门面消费，行为不变）。
 *
 * 投影折叠的来历与回退判决（ADR-0018 scope 收窄）见门面 `workbenchProjector.ts`
 * 的模块头注——那是整条管线的入口与档案位。
 */
import type { ContentPart } from './content/contentPartSchema.ts'
import { createEmptyGoalState, createEmptyPlanState, type GoalState, type PlanState } from './plan/goalModel.ts'
import { createEmptyLifecycleState, type LifecycleState, type NormalizedError } from './lifecycle/lifecycleModel.ts'
import type { ExtensionEvent, WorkbenchEventEnvelope } from './events/workbenchEventSchema.ts'
import { EMPTY_ASSIST_SNAPSHOT, type AssistSnapshot, type SessionCommand, type SessionConfigOption, type UsageSnapshot } from './session/sessionSurface.ts'

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
  /** #155 T3：重启恢复的临时消息，等待用户决定保留或丢弃。 */
  readonly interruptedDraft?: boolean
  readonly draftId?: string
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
  /** Agent 给的会话标题（ACP `session_info_update.title`）。缺省 = 当前无名——
   *  Agent 推 `title: null` 会被投影删键，所以这里不存在「空标题」中间态。 */
  readonly title?: string
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
  /** #446：同码计数环——同 code 非 error 的后续诊断不再逐条追加，记在首条上。 */
  readonly count?: number
  /** #446：该条目的 data 因字节预算被摘除（卡片仍在，载荷让位）。 */
  readonly dataOmitted?: true
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

// —— 状态词汇（原单文件内的模块级常量；reducer / selector / diagnostics 三件共用，
// 故上收类型层。**不经门面再导出**——公开面与拆分前一致）——

/** 工具生命周期终态（C04 终态幂等合并与 toolInvocationSnapshot 判定共用）。 */
export const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

export const TERMINAL_SESSION_STATUSES = new Set(['completed', 'error', 'failed', 'cancelled'])
export const SESSION_LIFECYCLE_STATUSES = new Set(['idle', 'loading', 'ready', 'degraded', 'running', 'generating', 'thinking', 'responding', 'working', ...TERMINAL_SESSION_STATUSES])

// —— 冻结工具（#204③/#375-e，原单文件尾部工具区）——

/** C04：把 normalized 字段冻结为可安全持有的 Json 快照（非 JSON 值降级为 undefined）。 */
/**
 * #375-e/7：载荷字段**不再克隆**——只冻结后就地共享。
 *
 * 原实现（`jsonSnapshot` = `structuredClone`）对 `input/locations/progress/capabilities/
 * parts/rawOutput/rawInput` 逐字段无条件克隆：终态前的每次克隆都在下一拍作废（纯 churn），
 * 终态后还额外常驻一份。判据是这些字段**没有写入点**：`reduceTool` / `reduceActivity` /
 * `reduceExtension` 全部是"替换新建"，`upsertActivity` 只做浅合并，没有任何下游就地改写。
 * 冻结即把该判据变成运行时契约：一旦有人就地写就抛（开发期立刻暴露）。
 *
 * 收益不止省掉克隆：活动节点与信封语义事件**共享同一批载荷对象**，
 * 同一份载荷在文档里只存在一份。
 */
export function freezeJsonValue<T>(value: T): T | undefined {
  return value === undefined ? undefined : freezeDeepSnapshot(value)
}

/** #204③ 解冻基线：文档项在**构造时**冻结（O(新项数)），运行时 freezeDocument 据此走
 * 前缀共享快路——大数组整体 Object.freeze 在 JSC 是 O(N) 高成本操作（40k ≈ 18ms/次），
 * 逐帧执行曾占 live 每帧成本的绝大部分。深冻结是**保形**操作（只把同一形状里的对象/数组
 * 替换为冻结副本），`T` 即最精确的契约。 */
export function freezeDeepSnapshot<T>(value: T): T {
  return freezeDeepValue(value)
}

/**
 * 就地深冻结（#375-e）：**不重建**树——`map`/`Object.fromEntries` 那种写法是「深克隆 + 冻结」，
 * 与它要取代的 `structuredClone` 是同一笔分配账，白改。这里沿原引用递归递归冻结并原样返回，
 * 于是活动节点与信封语义事件**共享同一批载荷对象**，同一份载荷在文档里只剩一份。
 *
 * 判据（#375-e）：这些载荷字段没有写入点——reduce 系列全是替换新建、`upsertActivity` 只做浅
 * 合并；冻结把这个判据变成运行时契约，误写即抛。
 */
function freezeDeepValue<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeepValue(item)
    return Object.freeze(value) as T
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeDeepValue(nested)
    return Object.freeze(value) as T
  }
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
