import type { PluginIdentity } from '../pluginIdentity.ts'
import type { AsyncDisposable } from '../registry/types.ts'

export interface PluginEventEnvelope<T = unknown> {
  readonly event: string
  readonly payload: T
  readonly publishedAt: number
  readonly publisher?: PluginIdentity
}

export type PluginEventListener<T = unknown> = (event: PluginEventEnvelope<T>) => void | Promise<void>

export interface EventBusSnapshot {
  readonly revision: number
  readonly subscriptions: readonly {
    event: string
    ownerPluginId: string
    ownerRuntimeInstanceId: string
    subscriptionId: string
  }[]
}

interface Subscription {
  event: string
  owner: PluginIdentity
  subscriptionId: string
  listener: PluginEventListener
}

export class PluginEventBus {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private snapshot: EventBusSnapshot = Object.freeze({ revision: 0, subscriptions: Object.freeze([]) })

  subscribe<T>(
    owner: PluginIdentity,
    event: string,
    subscriptionId: string,
    listener: PluginEventListener<T>,
  ): AsyncDisposable {
    if (!event || !subscriptionId) throw new Error('Event/subscriptionId 不能为空')
    const key = `${owner.key}\u0000${subscriptionId}`
    if (this.subscriptions.has(key)) throw new Error(`Event subscription 重复：${subscriptionId}`)
    this.subscriptions.set(key, { event, owner, subscriptionId, listener: listener as PluginEventListener })
    this.publishSnapshot()
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        if (!this.subscriptions.delete(key)) return
        this.publishSnapshot()
      },
    }
  }

  async publish<T>(event: string, payload: T, publisher?: PluginIdentity): Promise<void> {
    const envelope: PluginEventEnvelope<T> = Object.freeze({
      event,
      payload,
      publishedAt: Date.now(),
      ...(publisher ? { publisher } : {}),
    })
    const matching = [...this.subscriptions.values()]
      .filter(subscription => subscription.event === event || subscription.event === '*')
      .sort((a, b) => a.subscriptionId < b.subscriptionId ? -1 : a.subscriptionId > b.subscriptionId ? 1 : 0)
    for (const subscription of matching) {
      try {
        await subscription.listener(envelope)
      } catch {
        // 单个插件监听器失败不得阻断其他监听器与宿主事件路径。
      }
    }
  }

  subscribeSnapshot(listener: () => void): () => void {
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): EventBusSnapshot {
    return this.snapshot
  }

  clear(): void {
    if (this.subscriptions.size === 0) return
    this.subscriptions.clear()
    this.publishSnapshot()
  }

  private publishSnapshot(): void {
    this.revision += 1
    this.snapshot = Object.freeze({
      revision: this.revision,
      subscriptions: Object.freeze([...this.subscriptions.values()]
        .map(subscription => ({
          event: subscription.event,
          ownerPluginId: subscription.owner.pluginId,
          ownerRuntimeInstanceId: subscription.owner.key,
          subscriptionId: subscription.subscriptionId,
        }))
        .sort((a, b) => a.subscriptionId < b.subscriptionId ? -1 : a.subscriptionId > b.subscriptionId ? 1 : 0)),
    })
    for (const listener of [...this.listeners]) listener()
  }
}
