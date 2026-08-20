/**
 * pluginEventBus —— canonical 事件到 v2 Event Bus 的兼容入口。
 *
 * 旧 capability broker API 保持不变，但订阅、快照和回收由 v2 PluginEventBus 承载。
 */
import type { CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import { getPluginEventBus } from '../../plugin-runtime/runtimeServices.ts'

export type PluginEventListener = (event: CanonicalConversationEvent) => void
export type PluginEventDisposable = () => void

const LEGACY_EVENT_NAME = 'canonical.conversation'
let sequence = 0
const active = new Map<string, ReturnType<ReturnType<typeof getPluginEventBus>['subscribe']>>()

export function subscribePluginEvents(listener: PluginEventListener): PluginEventDisposable {
  const subscriptionId = `legacy.plugin-event.${++sequence}`
  const owner = createPluginIdentity('legacy.capability-broker', `subscription-${sequence}`)
  const handle = getPluginEventBus().subscribe(
    owner,
    LEGACY_EVENT_NAME,
    subscriptionId,
    envelope => listener(envelope.payload as CanonicalConversationEvent),
  )
  active.set(subscriptionId, handle)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    active.delete(subscriptionId)
    void handle.dispose()
  }
}

export function publishPluginEvent(event: CanonicalConversationEvent): void {
  void getPluginEventBus().publish(LEGACY_EVENT_NAME, event)
}

export function clearPluginEventListenersForTests(): void {
  for (const handle of active.values()) void handle.dispose()
  active.clear()
}
