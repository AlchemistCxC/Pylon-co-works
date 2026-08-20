/**
 * sessionStateSync — 统一 Plugin Service Registry 的会话状态消费面。
 *
 * 主链路（useSessionLifecycle / chatEventController）只调 apply* 函数；
 * 产品 agent-adapters 插件激活时登记 provider，停用时由 owner scope 自动回收。
 */
import type { SessionStateSyncProvider } from '../../contracts/sessionStateSync.ts'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'

export function listSessionStateSyncProviders(): SessionStateSyncProvider[] {
  return getPluginServiceRegistry().list<SessionStateSyncProvider>('session-state')
}

function resolveActiveProvider(): SessionStateSyncProvider | undefined {
  return listSessionStateSyncProviders()[0]
}

export function applySessionStateResponse(context: unknown, response: unknown): void {
  resolveActiveProvider()?.applyResponse?.(context, response)
}

export function applySessionStateUpdate(context: unknown, kind: string, payload: unknown): void {
  resolveActiveProvider()?.applyUpdate?.(context, { kind, payload })
}
