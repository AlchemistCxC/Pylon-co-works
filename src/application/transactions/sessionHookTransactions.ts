/** Shared session hook transactions used by GUI and external control surfaces. */
import type {
  HookSessionRef,
  MessageUserBeforeSendEvent,
} from '../../plugin-runtime/hooks/hookTypes.ts'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'

export interface HookEnabledSession extends HookSessionRef {}

export function enabledHookIds(session: Pick<HookEnabledSession, 'hooks'>): string[] | undefined {
  const hooks = session.hooks
  return hooks && hooks.length > 0 ? [...hooks] : undefined
}

/**
 * beforeSend 唯一方言 {source, content, blocks}(ADR-0001):GUI/kernel 与 CLI
 * 共用同一形状;CLI 文本链只消费 content,blocks 恒为空数组。transform 协议
 * = 改写 event.content。会话未 opt-in(hooks 空)时零派发(fail-closed 同 kernel 域)。
 */
export async function runUserMessageBeforeHook(
  session: HookEnabledSession,
  content: string,
): Promise<{ blocked: boolean; reason?: string; content: string }> {
  const enabled = enabledHookIds(session)
  if (!enabled) return { blocked: false, content }
  const runtime = getHookRuntime()
  if (!runtime.hasEnabledHooks('message.user.beforeSend', enabled)) return { blocked: false, content }
  const event: MessageUserBeforeSendEvent = { source: session.source, content, blocks: [] }
  const result = await runtime.invoke('message.user.beforeSend', event, enabled)
  const transformed = result.event as Partial<MessageUserBeforeSendEvent> | undefined
  return {
    blocked: result.action === 'cancel',
    reason: result.reason,
    content: typeof transformed?.content === 'string' ? transformed.content : content,
  }
}

/**
 * 会话边界通知:created 在本地事务提交后、closed 在远端 close 成功后触发。
 * gate 语义仅对显式 pipeline 注册生效(cancel 短路)。
 */
export async function runSessionBoundaryHook(
  anchor: 'session.created' | 'session.closed',
  session: HookEnabledSession,
): Promise<{ blocked: boolean }> {
  const enabled = enabledHookIds(session)
  if (!enabled) return { blocked: false }
  const runtime = getHookRuntime()
  if (!runtime.hasEnabledHooks(anchor, enabled)) return { blocked: false }
  const result = await runtime.invoke(anchor, { session, source: session.source }, enabled)
  return { blocked: result.action === 'cancel' }
}

/**
 * 生命周期通知锚点(观察语义,结果不回读)。awaited 派发只为保证删除事务中
 * closing→deleting→deleted→closed 的派发顺序;invoke 自身已吞 handler 故障。
 */
export async function runSessionNotificationHook(
  anchor: 'session.closing' | 'session.deleting' | 'session.deleted' | 'session.closed',
  session: HookEnabledSession,
): Promise<void> {
  const enabled = enabledHookIds(session)
  if (!enabled) return
  const runtime = getHookRuntime()
  if (!runtime.hasEnabledHooks(anchor, enabled)) return
  await runtime.invoke(anchor, { session, source: session.source }, enabled)
}
