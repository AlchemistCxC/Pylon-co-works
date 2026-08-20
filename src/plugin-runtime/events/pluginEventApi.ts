import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import { PluginEventBus, type PluginEventListener } from './pluginEventBus.ts'

export interface PluginEventApi {
  subscribe<T>(event: string, subscriptionId: string, listener: PluginEventListener<T>): ReturnType<PluginEventBus['subscribe']>
  publish<T>(event: string, payload: T): Promise<void>
}

export function createPluginEventApi(
  bus: PluginEventBus,
  identity: PluginIdentity,
  scope: PluginScope,
): PluginEventApi {
  return {
    subscribe(event, subscriptionId, listener) {
      return scope.add(bus.subscribe(identity, event, subscriptionId, listener))
    },
    publish: (event, payload) => bus.publish(event, payload, identity),
  }
}
