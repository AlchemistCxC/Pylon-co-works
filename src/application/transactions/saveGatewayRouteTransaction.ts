/**
 * saveGatewayRouteTransaction — 网关路由保存事务（报告阶段 3.5 / 5B / FE-AUD-004）。
 *
 * validate → 读取既有 routes → upsert by source（同 source 替换，否则追加，保留
 * profileId/sessionKey/instanceId/allowFrom/reset/idleMinutes 全字段）→ save →
 * reload → read-back → 只有回读逐字段一致才 ok。区分：保存失败(transport)、reload
 * 失败(mismatch 磁盘已更新)、回读不一致(mismatch)。
 *
 * ISSUE-12 W6（LR2-WI01）round-trip 契约：
 * - 写回 payload 的 route 必须使用 yaml 键（agent/profile/session/instance/
 *   allow_from/reset/idle_minutes）——后端 EntityBinding 的 yaml 契约
 *   （route.rs #[serde(rename)]）；wire camelCase 键会被 parse_config 拒绝
 *   （Rust strict fixture 已钉死）。gatewayRouteToConfigEntry 承载该适配。
 * - 回读必须逐字段比较（source/agentId/profileId/sessionKey/instanceId/allowFrom/
 *   reset/idleMinutes），source+agentId 两点比较无法发现 instanceId 静默丢失。
 */
import type { GatewayRouteReset } from '../../infrastructure/tauri/gatewayContracts'
import { isGatewayRouteReset } from '../../infrastructure/tauri/gatewayContracts'
import type { TransactionResult } from './transactionResult'

export interface GatewayRouteShape {
  source: string
  agentId: string
  profileId?: string
  sessionKey?: string
  /** 引用 adapter instance id（I12-A-BE-01）；缺省 = 未绑定实例（legacy 路由）。 */
  instanceId?: string
  allowFrom?: string[]
  reset?: GatewayRouteReset
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
  // I12 W6：新 route 的 instance/profile/session 若提供必须非空（存在性/有效性
  // 校验在 UI 表单层 + 后端；此处防空白字符串进入写回契约）
  if (route.instanceId !== undefined && !route.instanceId.trim()) return 'instanceId 不能为空'
  if (route.profileId !== undefined && !route.profileId.trim()) return 'profileId 不能为空'
  if (route.sessionKey !== undefined && !route.sessionKey.trim()) return 'sessionKey 不能为空'
  if (route.reset !== undefined && !isGatewayRouteReset(route.reset)) return 'reset 必须是 idle/daily/off'
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

/**
 * I12 W6：camelCase DTO → yaml 键写回条目。后端 EntityBinding 反序列化只认
 * agent/profile/session/instance/allow_from/reset/idle_minutes（route.rs），
 * wire camelCase 键会被 flatten 收集进 extra 并因缺必填字段报错（Rust strict
 * fixture）。source 恒保留；可选字段缺省不产出（后端 Option 语义）。
 */
export function gatewayRouteToConfigEntry(route: GatewayRouteShape): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    source: route.source,
    agent: route.agentId,
  }
  if (route.profileId) entry.profile = route.profileId
  if (route.sessionKey) entry.session = route.sessionKey
  if (route.instanceId) entry.instance = route.instanceId
  if (route.allowFrom) entry.allow_from = route.allowFrom
  if (route.reset) entry.reset = route.reset
  if (route.idleMinutes !== undefined) entry.idle_minutes = route.idleMinutes
  return entry
}

/** 归一化后比较：可选字段缺省/空串/null 等价；allowFrom 按排序数组；reset 缺省=idle */
function comparable(route: GatewayRouteShape): {
  source: string
  agentId: string
  profileId: string
  sessionKey: string
  instanceId: string
  allowFrom: readonly string[]
  reset: GatewayRouteReset
  idleMinutes: number | null
} {
  return {
    source: route.source,
    agentId: route.agentId,
    profileId: route.profileId?.trim() ?? '',
    sessionKey: route.sessionKey?.trim() ?? '',
    instanceId: route.instanceId?.trim() ?? '',
    allowFrom: [...(route.allowFrom ?? [])].sort(),
    reset: route.reset ?? 'idle',
    idleMinutes: route.idleMinutes ?? null,
  }
}

/** 路由 source → 平台前缀（`qq:group:123` → `qq`）；缺前缀返回 null。 */
export function routeSourcePlatform(source: string): string | null {
  const idx = source.indexOf(':')
  return idx > 0 ? source.slice(0, idx) : null
}

/**
 * I12 W6 旧 route 迁移：仅当 route 平台前缀对应**恰好一个 enabled instance** 时自动补
 * 绑定 instanceId；零/多实例保持 Unbound（禁止歧义 fallback）。已绑定 route 不变。
 * 纯函数——UI 在保存时对既有 routes 应用本迁移（读回侧同规则，保证比较一致）。
 */
export function migrateLegacyRouteBindings(
  routes: readonly GatewayRouteShape[],
  enabledInstances: ReadonlyArray<{ id: string; platform: string }>,
): GatewayRouteShape[] {
  return routes.map(route => {
    if (route.instanceId) return route
    const platform = routeSourcePlatform(route.source)
    if (!platform) return route
    const matches = enabledInstances.filter(instance => instance.platform === platform)
    if (matches.length !== 1) return route
    return { ...route, instanceId: matches[0].id }
  })
}

/** I12 W6：read-back 逐字段比较（source 为 upsert 键，命中后全字段对齐才算生效）。 */
export function gatewayRouteFieldsEqual(a: GatewayRouteShape, b: GatewayRouteShape): boolean {
  const ca = comparable(a)
  const cb = comparable(b)
  return (
    ca.source === cb.source &&
    ca.agentId === cb.agentId &&
    ca.profileId === cb.profileId &&
    ca.sessionKey === cb.sessionKey &&
    ca.instanceId === cb.instanceId &&
    ca.reset === cb.reset &&
    ca.idleMinutes === cb.idleMinutes &&
    ca.allowFrom.length === cb.allowFrom.length &&
    ca.allowFrom.every((value, index) => value === cb.allowFrom[index])
  )
}

export async function saveGatewayRouteTransaction(
  route: GatewayRouteShape,
  deps: SaveGatewayRouteDeps,
): Promise<TransactionResult<GatewayRouteShape[]>> {
  // CR-002：source 归一化——后端 parse_config 对 source trim（route.rs），
  // 写回与 read-back 命中必须用同一归一化值，否则带空白 source 假 mismatch。
  const normalized = { ...route, source: route.source.trim() }
  const validation = validateGatewayRoute(normalized)
  if (validation) return { ok: false, kind: 'validation', message: validation }

  let existing: GatewayRouteShape[]
  try {
    existing = await deps.readRoutes()
  } catch (error) {
    deps.reportError('读取网关路由', error)
    return { ok: false, kind: 'transport', message: '读取既有路由失败', cause: error }
  }
  const routes = upsertGatewayRoute(existing, normalized)

  try {
    await deps.saveRoutes({ scope: 'gateway', config: { gateway: { routes: routes.map(gatewayRouteToConfigEntry) } } })
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
  // I12 W6 逐字段比较 + CR-001：比较基线是**实际写出的合并条目**（upsert 后
  // routes 中同 source 项），而非原始输入 route——生产表单只提交 source+agentId，
  // 用原始输入比较会让重存既有可选字段路由必然假 mismatch（保存实际成功被判失败）。
  // 语义不变：instanceId 等字段被 normalize/写回静默丢弃仍必须被捕获为 mismatch。
  const written = routes.find(item => item.source === normalized.source)
  const saved = readBack.find(item => item.source === normalized.source)
  if (!written || !saved || !gatewayRouteFieldsEqual(written, saved)) {
    return { ok: false, kind: 'mismatch', message: '保存后回读不一致，路由字段未完整生效' }
  }
  return { ok: true, value: readBack }
}
