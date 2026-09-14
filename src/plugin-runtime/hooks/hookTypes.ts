/**
 * 插件 Hook 锚点词表与事件 schema(插件 API 1.3 契约,ADR-0001)。
 *
 * 单层契约:每个锚点在本文件同时声明「名字」「事件形状」「超时预算」,
 * 由 scripts/check-hook-anchor-parity.mts 与 Rust 锚点常量、开发者手册 §6.2
 * 强制三方一致(#37 教训:派发面不得出现词表之外的锚点)。
 *
 * 执行语义(HookRuntime):故障永不阻断主循环——失败按 failurePolicy 处理,
 * 默认 continue;gate 类锚点 cancel 才短路,其余动作忽略或原样放行。
 */
export const HOOK_NAMES = [
  'context.afterBuild',
  'context.beforeBuild',
  'message.received',
  'message.user.beforeSend',
  'message.user.sendFailed',
  'message.user.sent',
  'permission.request',
  'session.closed',
  'session.closing',
  'session.creating',
  'session.created',
  'session.deleted',
  'session.deleting',
  'session.loaded',
  'session.loading',
  'tool.afterCall',
  'tool.beforeCall',
  'tool.failed',
  'tool.started',
  'turn.cancelled',
  'turn.completed',
  'turn.failed',
  'turn.started',
] as const

export type HookName = typeof HOOK_NAMES[number]
export type HookMode = 'notification' | 'pipeline'
export type HookExecution = 'blocking' | 'background'
export type HookFailurePolicy = 'continue' | 'abort' | 'disable-hook' | 'disable-plugin'

/**
 * 每锚点默认超时预算(毫秒):gate 类 3000(与 kernel 桥 Rust 时钟外层一致),
 * 通知/投影类 1000。HookRegistry 在 definition 未显式给 timeoutMs 时取此表。
 */
const HOOK_GATE_TIMEOUT_MS = 3_000
const HOOK_NOTIFY_TIMEOUT_MS = 1_000
const GATE_ANCHORS: ReadonlySet<HookName> = new Set([
  'message.received',
  'message.user.beforeSend',
  'permission.request',
  'tool.beforeCall',
])
export const HOOK_TIMEOUT_BUDGET_MS: Readonly<Record<HookName, number>> = Object.freeze(
  Object.fromEntries(HOOK_NAMES.map(name => [
    name,
    GATE_ANCHORS.has(name) ? HOOK_GATE_TIMEOUT_MS : HOOK_NOTIFY_TIMEOUT_MS,
  ])),
) as Readonly<Record<HookName, number>>

// ── 每锚点事件 schema(文档级契约;handler 泛型由插件自行声明) ─────────────

/** 生命周期/边界类事件携带的会话引用(结构子集,传完整 Session 对象亦合法)。 */
export interface HookSessionRef {
  id: string
  agentId: string
  source: string
  hooks?: readonly string[]
}

/**
 * message.user.beforeSend:发送链缝唯一方言。
 * transform 协议 = 改写 `content`(文本)与 `blocks`(wire 块数组)。
 */
export interface MessageUserBeforeSendEvent {
  source: string
  content: string
  blocks: readonly unknown[]
  injectActivated?: readonly string[]
  canonicalEvent?: unknown
}

/** message.received:平台入站缝。transform 协议 = 改写 `content`。 */
export interface MessageReceivedEvent {
  source: string
  content: string
  binding?: unknown
  msgId?: string
}

/**
 * permission.request:权限缝(ACP session/request_permission)。
 * 决策协议:allow → `{ action:'respond', output:{ decision:'allow' } }`;
 * deny → `{ action:'cancel', reason }`;modify → `{ action:'continue', event:{
 * ...event, options: 过滤后的选项 } }`(仅允许原 optionId 子集的过滤/重排,
 * 不可新增)。未短路(continue 且无 options 改写)交回常规审批流。
 */
export interface PermissionRequestEvent {
  source: string
  provider?: string
  agentId?: string
  requestId: string
  toolCallId: string
  title: string
  prompt: string
  options: ReadonlyArray<Record<string, unknown> & { optionId: string }>
}

/** tool.beforeCall:权限缝 gate,cancel → 按 reject 选项应答。 */
export interface ToolBeforeCallEvent {
  source: string
  toolCallId: string
  title: string
  prompt: string
  options: ReadonlyArray<Record<string, unknown> & { optionId: string }>
}

/** context.beforeBuild / context.afterBuild:prompt 块构建缝,observe-only。 */
export interface ContextBuildEvent {
  source: string
  blockCount: number
  phase: 'before' | 'after'
}

/** turn.started / turn.cancelled:发送链出站/取消路径派发(字段以实际派发为准)。 */
export interface TurnTransitionEvent {
  source: string
  periId?: string
  agentId?: string
  reason?: string
}

/** canonical 投影类锚点(turn.completed/failed、tool.started/afterCall/failed)。 */
export interface CanonicalProjectionEvent {
  owner: {
    profileId: string
    agentId: string
    localSessionId: string
    remoteSessionId?: string
    workspaceId?: string
  }
  event: {
    eventId: string
    eventType: string
    stopReason?: string
    toolCallId?: string
    toolTitle?: string
  }
}

export interface HookInvocationContext<TEvent = unknown> {
  readonly invocationId: string
  readonly hookName: HookName
  readonly event: TEvent
  readonly signal: AbortSignal
  readonly triggeredBy?: { readonly kind: 'user' | 'hook'; readonly pluginId?: string; readonly hookName?: HookName; readonly depth: number }
}

export type HookActionResult<TEvent = unknown> =
  | { action: 'continue'; event?: TEvent }
  | { action: 'cancel'; reason: string }
  | { action: 'respond'; output: unknown }
  | { action: 'send'; message: string }
  | void

export interface HookDefinition<TEvent = unknown> {
  id: string
  mode: HookMode
  priority?: number
  execution?: HookExecution
  timeoutMs?: number
  failurePolicy?: HookFailurePolicy
  handler(context: HookInvocationContext<TEvent>): HookActionResult<TEvent> | Promise<HookActionResult<TEvent>>
}

export interface HookTraceEntry {
  invocationId: string
  hookName: HookName
  pluginId: string
  runtimeInstanceId: string
  handlerId: string
  startedAt: number
  durationMs: number
  outcome: 'continued' | 'transformed' | 'cancelled' | 'responded' | 'failed' | 'timed-out' | 'skipped' | 'plugin-disable-failed'
  error?: string
}

export interface HookInvocationResult<TEvent = unknown> {
  action: 'continue' | 'cancel' | 'respond' | 'send'
  event: TEvent
  reason?: string
  output?: unknown
  message?: string
  executed: number
  skipped: number
}

export interface HookCircuitDescriptor {
  pluginId: string
  failures: number
  openedAt: number | null
}
