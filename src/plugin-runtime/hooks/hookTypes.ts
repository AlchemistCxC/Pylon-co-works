export const HOOK_NAMES = [
  'session.creating',
  'session.created',
  'session.loading',
  'session.loaded',
  'session.closing',
  'session.closed',
  'session.deleting',
  'session.deleted',
  'message.user.beforeSend',
  'message.user.sent',
  'message.user.sendFailed',
  'message.received',
  'message.agent.committed',
  'agent.chunk',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'tool.beforeCall',
  'tool.started',
  'tool.afterCall',
  'tool.failed',
  'context.beforeBuild',
  'context.afterBuild',
] as const

export type HookName = typeof HOOK_NAMES[number]
export type HookMode = 'notification' | 'pipeline'
export type HookExecution = 'blocking' | 'background'
export type HookFailurePolicy = 'continue' | 'abort' | 'disable-hook' | 'disable-plugin'

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
