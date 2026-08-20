/**
 * agent.hook 扩展点契约（施工方案书 v3 §4.2）。
 *
 * 七 phase + 三效应；hook 故障永不阻断主循环：
 * - observe 失败吞掉上报；
 * - transform 失败跳过（用原文）；
 * - gate 失败放行。
 * 执行器在 host/hookPipeline.ts。
 */
export type HookPhase =
  | 'session.start'
  | 'user.message.before'
  | 'agent.turn.before'
  | 'tool.call.before'
  | 'tool.call.after'
  | 'agent.reply.after'
  | 'session.end'

export interface HookContext {
  phase: HookPhase
  agentId: string
  source: string
  sessionId?: string
  /** user.message.before / agent.reply.after 的当前消息文本。 */
  message?: string
  /** tool / 其他 wire payload（transform 可改写后继续）。 */
  payload?: unknown
  toolCallId?: string
  now: number
}

export type HookResult =
  | { effect: 'observe' }
  | { effect: 'transform'; message?: string; payload?: unknown }
  | { effect: 'gate'; block: true; reason: string }

export interface HookRunner {
  /** 本贡献处理的 phase（一个贡献可处理多 phase）。 */
  phases: readonly HookPhase[]
  run(context: HookContext): HookResult | Promise<HookResult>
}

export interface HookPhaseResult {
  blocked: boolean
  reason?: string
  message?: string
  payload?: unknown
  executed: number
  skipped: number
}

/** 单 hook 超时（毫秒）。 */
export const HOOK_TIMEOUT_MS = 50
/** 连续失败熔断阈值。 */
export const HOOK_FAILURE_LIMIT = 3
/** 熔断冷却（毫秒）。 */
export const HOOK_COOLDOWN_MS = 60_000
