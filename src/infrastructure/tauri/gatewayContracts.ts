/**
 * gatewayContracts — 网关状态 wire 收窄（W3-01）。
 *
 * gateway_status（§2.9）宽容 normalize：adapters/routes/qq/inject 形状漂移不崩
 * （损坏 route 容错——缺字段用缺省，非数组跳过）；route 只读展示，inject 归 Prism
 * 不编辑（本 commit 只读概览）。
 *
 * ISSUE-12 W6（LR2-WI01）route typed contract：route 是
 * { source, agentId, profileId, sessionKey, instanceId, allowFrom, reset, idleMinutes }
 * 八字段 wire 形状（camelCase，镜像 route.rs 手写 Serialize 的 golden 契约）。
 * normalize 必须保留 instanceId——否则「normalize 后整体回写」会静默清空所有
 * 实例绑定（ISSUE-12 问题 1）。instanceId 缺省仅对 legacy 路由（未绑定实例）成立。
 */

export type GatewayRouteReset = 'idle' | 'daily' | 'off'

export const GATEWAY_ROUTE_RESETS: readonly GatewayRouteReset[] = ['idle', 'daily', 'off']

export function isGatewayRouteReset(value: unknown): value is GatewayRouteReset {
  return typeof value === 'string' && (GATEWAY_ROUTE_RESETS as readonly string[]).includes(value)
}

export interface GatewayRoute {
  source: string
  agentId: string
  profileId?: string
  sessionKey?: string
  /** 引用 adapter instance id（I12-A-BE-01 契约冻结）；缺省 = 未绑定实例（legacy 路由）。 */
  instanceId?: string
  allowFrom?: string[]
  reset: GatewayRouteReset
  idleMinutes?: number
}

export interface GatewayStatus {
  adapters: string[]
  routes: GatewayRoute[]
  qq: { groupAllowFrom?: string[] } | null
  /** 未绑定消息策略（I12 W9）：active-agent（缺省，回退）| reject（拒绝） */
  unboundPolicy?: 'active-agent' | 'reject'
  inject: { enabled?: boolean; scenario?: string; sources?: string[]; persist?: string } | null
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type GatewayWriteStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok' }
  | { kind: 'blocked' }
  | { kind: 'lock-poisoned' }
  | { kind: 'error'; message: string }

/** Phase 2（后端施工计划书 §4）：平台会话行（gateway_sessions 响应，宽容 normalize） */
export interface PlatformSession {
  agentId: string
  source: string
  periId: string
  title: string
  model: string
  mode: string | null
  updatedAt: string | null
  reset: string
  allowFrom: string[] | null
  idleMinutes: number | null
}

export function normalizeGatewaySessions(raw: unknown): PlatformSession[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): PlatformSession[] => {
    if (!isPlainObject(item)) return []
    const value = item as Record<string, unknown>
    if (typeof value.agentId !== 'string' || typeof value.source !== 'string') return []
    return [{
      agentId: value.agentId,
      source: value.source,
      periId: typeof value.periId === 'string' ? value.periId : '',
      title: typeof value.title === 'string' ? value.title : '',
      model: typeof value.model === 'string' ? value.model : '',
      mode: typeof value.mode === 'string' ? value.mode : null,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
      reset: typeof value.reset === 'string' ? value.reset : 'idle',
      allowFrom: Array.isArray(value.allowFrom) ? value.allowFrom.filter((x): x is string => typeof x === 'string') : null,
      idleMinutes: typeof value.idleMinutes === 'number' && Number.isFinite(value.idleMinutes) ? value.idleMinutes : null,
    }]
  })
}

/** W3-02 桩化：写回错误分类（命令缺失 blocked；gateway_config_lock_poisoned 锁中毒） */
export function classifyGatewayWriteError(error: unknown): Exclude<GatewayWriteStatus, { kind: 'idle' } | { kind: 'saving' } | { kind: 'ok' }> {
  const message = error instanceof Error ? error.message : String(error)
  if (/not ?found|不存在|unknown command|no such command/i.test(message)) return { kind: 'blocked' }
  if (/lock_poisoned|锁中毒/i.test(message)) return { kind: 'lock-poisoned' }
  return { kind: 'error', message: message && message !== '[object Object]' ? message : '网关配置保存失败' }
}

export function normalizeGatewayStatus(raw: unknown): GatewayStatus {
  if (!isPlainObject(raw)) return { adapters: [], routes: [], qq: null, inject: null }
  return {
    adapters: Array.isArray(raw.adapters) ? raw.adapters.filter((item): item is string => typeof item === 'string') : [],
    // I12 W9：unboundPolicy 宽容 normalize（非法值缺省不产出）
    ...(raw.unboundPolicy === 'active-agent' || raw.unboundPolicy === 'reject' ? { unboundPolicy: raw.unboundPolicy } : {}),
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
        // I12 W6：instanceId 必须透传（实例绑定不得在 normalize 层静默丢失）
        ...(typeof route.instanceId === 'string' && route.instanceId.length > 0 ? { instanceId: route.instanceId } : {}),
        ...(Array.isArray(route.allowFrom) ? { allowFrom: route.allowFrom.filter((item): item is string => typeof item === 'string') } : {}),
        reset: isGatewayRouteReset(route.reset) ? route.reset : 'idle',
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
