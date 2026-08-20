/** Shared session hook transactions used by GUI and external control surfaces. */
import type { HookContext, HookPhase } from '../../contracts/agentHook.ts'
import { hasEnabledHooks, runHookPhase } from '../../host/hookPipeline.ts'

export interface HookEnabledSession {
  agentId: string
  source: string
  id?: string
  hooks?: readonly string[]
}

export function enabledHookIds(session: Pick<HookEnabledSession, 'hooks'>): string[] | undefined {
  const hooks = session.hooks
  return hooks && hooks.length > 0 ? [...hooks] : undefined
}

export async function runUserMessageBeforeHook(
  session: HookEnabledSession,
  content: string,
): Promise<{ blocked: boolean; reason?: string; content: string }> {
  const enabled = enabledHookIds(session)
  if (!hasEnabledHooks('user.message.before', enabled)) return { blocked: false, content }
  const result = await runHookPhase('user.message.before', {
    phase: 'user.message.before',
    agentId: session.agentId,
    source: session.source,
    sessionId: session.id,
    message: content,
    now: Date.now(),
  }, enabled)
  return {
    blocked: result.blocked,
    reason: result.reason,
    content: result.message ?? content,
  }
}

export async function runSessionBoundaryHook(
  phase: Extract<HookPhase, 'session.start' | 'session.end'>,
  session: HookEnabledSession,
): Promise<{ blocked: boolean }> {
  const enabled = enabledHookIds(session)
  if (!hasEnabledHooks(phase, enabled)) return { blocked: false }
  const context: HookContext = {
    phase,
    agentId: session.agentId,
    source: session.source,
    sessionId: session.id,
    now: Date.now(),
  }
  const result = await runHookPhase(phase, context, enabled)
  return { blocked: result.blocked }
}
