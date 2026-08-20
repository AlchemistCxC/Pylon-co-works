import type { HookContext, HookPhase, HookResult, HookRunner } from '../../contracts/agentHook.ts'
import type { CwdHookProvider } from '../../contracts/cwdPoints.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import { HookRuntime } from './hookRuntime.ts'
import type { HookName } from './hookTypes.ts'

export interface ProductHookEvent {
  phase: HookPhase
  agentId: string
  source: string
  sessionId?: string
  message?: string
  payload?: unknown
  toolCallId?: string
  now: number
}

export interface HookPhaseBridgeResult {
  blocked: boolean
  reason?: string
  message?: string
  payload?: unknown
  executed: number
  skipped: number
}

export const HOOK_PHASE_MAP: Record<HookPhase, HookName> = {
  'session.start': 'session.created',
  'user.message.before': 'message.user.beforeSend',
  'agent.turn.before': 'turn.started',
  'tool.call.before': 'tool.beforeCall',
  'tool.call.after': 'tool.afterCall',
  'agent.reply.after': 'message.agent.committed',
  'session.end': 'session.closed',
}

function hookResultToAction(result: HookResult, event: ProductHookEvent) {
  if (result.effect === 'gate' && result.block) return { action: 'cancel' as const, reason: result.reason }
  if (result.effect === 'transform') {
    return {
      action: 'continue' as const,
      event: {
        ...event,
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(result.payload !== undefined ? { payload: result.payload } : {}),
      },
    }
  }
  return { action: 'continue' as const }
}

export function registerHookPhaseRunner(
  runtime: HookRuntime,
  identity: PluginIdentity,
  scope: PluginScope,
  contributionId: string,
  runner: HookRunner | CwdHookProvider,
  priority = 1000,
): void {
  for (const phase of runner.phases) {
    const hookName = HOOK_PHASE_MAP[phase]
    scope.add(runtime.registry.register(identity, hookName, {
      id: `${contributionId}:${phase}`,
      mode: phase === 'user.message.before' || phase === 'tool.call.before' || phase === 'agent.turn.before'
        ? 'pipeline'
        : 'notification',
      priority,
      timeoutMs: 50,
      failurePolicy: 'continue',
      handler: async ({ event }) => {
        const legacyEvent = event as ProductHookEvent
        const context: HookContext = {
          phase,
          agentId: legacyEvent.agentId,
          source: legacyEvent.source,
          sessionId: legacyEvent.sessionId,
          message: legacyEvent.message,
          payload: legacyEvent.payload,
          toolCallId: legacyEvent.toolCallId,
          now: legacyEvent.now,
        }
        return hookResultToAction(await runner.run(context), legacyEvent)
      },
    }))
  }
}

export async function runHookPhaseWithRuntime(
  runtime: HookRuntime,
  phase: HookPhase,
  context: HookContext,
  enabledPluginIds?: readonly string[],
): Promise<HookPhaseBridgeResult> {
  const result = await runtime.invoke(HOOK_PHASE_MAP[phase], { ...context, phase }, enabledPluginIds)
  const event = result.event as ProductHookEvent
  return {
    blocked: result.action === 'cancel',
    reason: result.reason,
    message: event.message,
    payload: event.payload,
    executed: result.executed,
    skipped: result.skipped,
  }
}
