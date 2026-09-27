/**
 * canonicalHookProjection — canonical 事实 → 插件 hook 锚点投影(observe-only)。
 *
 * 订阅 pluginEventBus 的 durable-before-publish 扇出点(canonicalEventSink 落盘
 * 成功后才 publish),因此插件只会看到已提交的会话事实;sink 轨的 replay 不经过
 * 本入口,不会重复触发。**边界披露**:canonicalEventFeed 的 gap 回填/recovered
 * 行同样经 bus 发布——会话打开期间丢帧后被回填的历史行会触发一次投影(幂等于
 * 事实本身,seed 纪律保证不重放打开前历史,cursor 按 sequence 去重防双发)。
 * opt-in 沿用会话 hooks 列表(空 = 零派发,fail-closed 同 kernel 域);
 * 派发 fire-and-forget,绝不阻塞事件主链(HookRuntime 自带超时/熔断兜底)。
 *
 * 锚点映射(API 1.3 词表):tool.call.started→tool.started、tool.call.completed→
 * tool.afterCall、tool.call.failed→tool.failed、turn.completed→turn.completed、
 * turn.failed→turn.failed(stopReason=cancelled 细分为 turn.cancelled,与 normalizer
 * 的取消标注一致,避免与终态锚点双发)。
 */
import type { CanonicalConversationEvent } from '../../domains/events/eventSchema'
import type {
  CanonicalProjectionEvent,
  HookName,
} from '../../plugin-runtime/hooks/hookTypes.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'
import { subscribePluginEvents, type PluginEventDisposable } from '../../infrastructure/events/pluginEventBus.ts'

const PROJECTION_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'tool.call.started',
  'tool.call.completed',
  'tool.call.failed',
  'turn.completed',
  'turn.failed',
])

/** canonical 事件(stopReason 细分)→ hook 锚点;非投影事件返回 undefined。 */
export function canonicalAnchorFor(event: Pick<CanonicalConversationEvent, 'eventType' | 'typedPayload'>): HookName | undefined {
  if (!PROJECTION_SOURCE_TYPES.has(event.eventType)) return undefined
  if (event.eventType === 'turn.failed' && readStopReason(event) === 'cancelled') return 'turn.cancelled'
  switch (event.eventType) {
    case 'tool.call.started': return 'tool.started'
    case 'tool.call.completed': return 'tool.afterCall'
    case 'tool.call.failed': return 'tool.failed'
    case 'turn.completed': return 'turn.completed'
    default: return 'turn.failed'
  }
}

function readStopReason(event: Pick<CanonicalConversationEvent, 'typedPayload'>): string | undefined {
  const typed = event.typedPayload as { stopReason?: unknown } | undefined
  return typeof typed?.stopReason === 'string' ? typed.stopReason : undefined
}

function projectionEvent(event: CanonicalConversationEvent): CanonicalProjectionEvent {
  const typed = event.typedPayload as { tool?: { name?: unknown; title?: unknown } } | undefined
  const stopReason = readStopReason(event)
  return {
    owner: { ...event.owner },
    event: {
      eventId: event.eventId,
      eventType: event.eventType,
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(event.identity?.toolCallId !== undefined ? { toolCallId: event.identity.toolCallId } : {}),
      ...(typed?.tool && (typed.tool.name !== undefined || typed.tool.title !== undefined)
        ? { toolTitle: String(typed.tool.name ?? typed.tool.title ?? '') }
        : {}),
    },
  }
}

/** 落盘成功后的锚点派发入口;未 opt-in 或非投影事件零开销返回。 */
export function projectCanonicalEventToHooks(event: CanonicalConversationEvent): void {
  const anchor = canonicalAnchorFor(event)
  if (!anchor) return
  const session = useIdentityStore.getState().sessions.find(candidate => (
    candidate.agentId === event.owner.agentId
    && (candidate.source === event.owner.localSessionId || candidate.id === event.owner.localSessionId)
  ))
  if (!session || session.hooks.length === 0) return
  void getHookRuntime().invoke(anchor, projectionEvent(event), [...session.hooks])
}

let installation: PluginEventDisposable | undefined

/** 幂等安装;返回解订函数。 */
export function installCanonicalHookProjection(): () => void {
  installation ??= subscribePluginEvents(projectCanonicalEventToHooks)
  return installation
}

/** 测试隔离用:解绑当前安装并允许重装。 */
export function resetCanonicalHookProjectionForTests(): void {
  installation?.()
  installation = undefined
}
