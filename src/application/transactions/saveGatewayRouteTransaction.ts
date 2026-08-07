/**
 * saveGatewayRouteTransaction — 网关路由保存事务（报告阶段 3.5 / 5B / FE-AUD-004）。
 *
 * validate → 读取既有 routes → upsert by source（同 source 替换，否则追加，保留
 * profileId/sessionKey/allowFrom/reset/idleMinutes 全字段）→ save → reload →
 * read-back → 只有回读一致才 ok。区分：保存失败(transport)、reload 失败(mismatch
 * 磁盘已更新)、回读不一致(mismatch)。
 */
import type { TransactionResult } from './transactionResult'

export interface GatewayRouteShape {
  source: string
  agentId: string
  profileId?: string
  sessionKey?: string
  allowFrom?: string[]
  reset?: string
  idleMinutes?: number
}

export interface SaveGatewayRouteDeps {
  readRoutes: () => Promise<GatewayRouteShape[]>
  saveRoutes: (payload: Record<string, unknown>) => Promise<unknown>
  reload: () => Promise<unknown>
  readBackRoutes: () => Promise<GatewayRouteShape[]>
  reportError: (action: string, error: unknown) => void
}

export function validateGatewayRoute(route: GatewayRouteShape): string | null {
  if (!route.source || !route.source.trim()) return 'source 不能为空'
  if (!route.agentId || !route.agentId.trim()) return 'agentId 不能为空'
  if (route.idleMinutes !== undefined && (!Number.isFinite(route.idleMinutes) || route.idleMinutes < 0)) return 'idleMinutes 必须是非负数字'
  return null
}

/** upsert by source：同 source 替换（保留既有全字段），否则追加 */
export function upsertGatewayRoute(existing: readonly GatewayRouteShape[], incoming: GatewayRouteShape): GatewayRouteShape[] {
  const normalized = { ...incoming }
  const hasSameSource = existing.some(route => route.source === incoming.source)
  return hasSameSource
    ? existing.map(route => (route.source === incoming.source ? { ...route, ...normalized } : route))
    : [...existing, normalized]
}

export async function saveGatewayRouteTransaction(
  route: GatewayRouteShape,
  deps: SaveGatewayRouteDeps,
): Promise<TransactionResult<GatewayRouteShape[]>> {
  const validation = validateGatewayRoute(route)
  if (validation) return { ok: false, kind: 'validation', message: validation }

  let existing: GatewayRouteShape[]
  try {
    existing = await deps.readRoutes()
  } catch (error) {
    deps.reportError('读取网关路由', error)
    return { ok: false, kind: 'transport', message: '读取既有路由失败', cause: error }
  }
  const routes = upsertGatewayRoute(existing, route)

  try {
    await deps.saveRoutes({ scope: 'gateway', config: { gateway: { routes } } })
  } catch (error) {
    deps.reportError('保存网关配置', error)
    const message = error instanceof Error ? error.message : String(error)
    // G3：命令缺失（后端未提供）→ blocked，UI 显示「待后端」（报告 5B）
    if (/command not found/i.test(message)) {
      return { ok: false, kind: 'blocked', message: '待后端：update_agents_config 命令尚未提供', cause: error }
    }
    return { ok: false, kind: 'transport', message: '保存网关配置失败', cause: error }
  }

  try {
    await deps.reload()
  } catch (error) {
    deps.reportError('重载网关', error)
    return { ok: false, kind: 'mismatch', message: '磁盘已更新、运行态仍旧配置', cause: error }
  }

  let readBack: GatewayRouteShape[]
  try {
    readBack = await deps.readBackRoutes()
  } catch (error) {
    deps.reportError('回读网关状态', error)
    return { ok: false, kind: 'mismatch', message: '保存后回读失败', cause: error }
  }
  if (!readBack.some(item => item.source === route.source && item.agentId === route.agentId)) {
    return { ok: false, kind: 'mismatch', message: '保存后回读不一致，路由未生效' }
  }
  return { ok: true, value: readBack }
}
