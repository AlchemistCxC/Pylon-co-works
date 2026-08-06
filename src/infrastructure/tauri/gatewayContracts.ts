/**
 * gatewayContracts — 网关状态 wire 收窄（W3-01）。
 *
 * gateway_status（§2.9）宽容 normalize：adapters/routes/qq/inject 形状漂移不崩
 * （损坏 route 容错——缺字段用缺省，非数组跳过）；route 只读展示，inject 归 Prism
 * 不编辑（本 commit 只读概览）。
 */

export interface GatewayRoute {
  source: string
  agentId: string
  profileId?: string
  sessionKey?: string
  allowFrom?: string[]
  reset: string
  idleMinutes?: number
}

export interface GatewayStatus {
  adapters: string[]
  routes: GatewayRoute[]
  qq: { groupAllowFrom?: string[] } | null
  inject: { enabled?: boolean; scenario?: string; sources?: string[]; persist?: string } | null
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function normalizeGatewayStatus(raw: unknown): GatewayStatus {
  if (!isPlainObject(raw)) return { adapters: [], routes: [], qq: null, inject: null }
  return {
    adapters: Array.isArray(raw.adapters) ? raw.adapters.filter((item): item is string => typeof item === 'string') : [],
    routes: Array.isArray(raw.routes) ? raw.routes.flatMap(route => {
      if (!isPlainObject(route)) return []
      const source = typeof route.source === 'string' && route.source.length > 0 ? route.source : undefined
      const agentId = typeof route.agentId === 'string' && route.agentId.length > 0 ? route.agentId : undefined
      if (!source || !agentId) return []
      return [{
        source,
        agentId,
        ...(typeof route.profileId === 'string' ? { profileId: route.profileId } : {}),
        ...(typeof route.sessionKey === 'string' ? { sessionKey: route.sessionKey } : {}),
        ...(Array.isArray(route.allowFrom) ? { allowFrom: route.allowFrom.filter((item): item is string => typeof item === 'string') } : {}),
        reset: typeof route.reset === 'string' && ['idle', 'daily', 'off'].includes(route.reset) ? route.reset : 'idle',
        ...(typeof route.idleMinutes === 'number' && Number.isFinite(route.idleMinutes) ? { idleMinutes: route.idleMinutes } : {}),
      }]
    }) : [],
    qq: isPlainObject(raw.qq) ? {
      ...(Array.isArray(raw.qq.groupAllowFrom) ? { groupAllowFrom: raw.qq.groupAllowFrom.filter((item): item is string => typeof item === 'string') } : {}),
    } : null,
    inject: isPlainObject(raw.inject) ? {
      ...(typeof raw.inject.enabled === 'boolean' ? { enabled: raw.inject.enabled } : {}),
      ...(typeof raw.inject.scenario === 'string' ? { scenario: raw.inject.scenario } : {}),
      ...(Array.isArray(raw.inject.sources) ? { sources: raw.inject.sources.filter((item): item is string => typeof item === 'string') } : {}),
      ...(typeof raw.inject.persist === 'string' ? { persist: raw.inject.persist } : {}),
    } : null,
  }
}
