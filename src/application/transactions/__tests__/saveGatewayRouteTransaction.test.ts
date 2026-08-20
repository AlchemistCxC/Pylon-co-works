/**
 * saveGatewayRouteTransaction 行为测试（报告 3.5 / 5B / FE-AUD-004）：
 * upsert by source、validation、save/reload/read-back 失败分类、回读一致才 ok。
 * ISSUE-12 W6（LR2-WI01）：yaml 键写回契约、8 字段 round-trip、字段漂移 mismatch。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  saveGatewayRouteTransaction,
  upsertGatewayRoute,
  validateGatewayRoute,
  gatewayRouteToConfigEntry,
  gatewayRouteFieldsEqual,
  migrateLegacyRouteBindings,
  routeSourcePlatform,
  type GatewayRouteShape,
} from '../saveGatewayRouteTransaction'

const EXISTING: GatewayRouteShape[] = [
  { source: 'qq:group:1', agentId: 'peri', profileId: 'profile-a', reset: 'idle', idleMinutes: 30, allowFrom: [] },
  { source: 'qq:group:2', agentId: 'profile-b', profileId: 'profile-a', reset: 'idle', idleMinutes: 30, allowFrom: [] },
]

function createDeps(overrides: Partial<Parameters<typeof saveGatewayRouteTransaction>[1]> = {}) {
  const calls: string[] = []
  const deps = {
    readRoutes: async () => { calls.push('read'); return EXISTING },
    saveRoutes: async (payload: Record<string, unknown>) => { calls.push(`save:${JSON.stringify(payload)}`) },
    reload: async () => { calls.push('reload') },
    readBackRoutes: async () => { calls.push('readback'); return [...EXISTING, { source: 'qq:group:3', agentId: 'peri' }] },
    reportError: vi.fn(),
    ...overrides,
  }
  return { deps, calls }
}

describe('upsertGatewayRoute', () => {
  it('同 source 替换保留全字段，否则追加', () => {
    const replaced = upsertGatewayRoute(EXISTING, { source: 'qq:group:1', agentId: 'new' })
    expect(replaced.length).toBe(2)
    expect(replaced.find(r => r.source === 'qq:group:1')?.agentId).toBe('new')
    const appended = upsertGatewayRoute(EXISTING, { source: 'qq:group:9', agentId: 'peri' })
    expect(appended.length).toBe(3)
  })
})

describe('validateGatewayRoute', () => {
  it('source/agentId/idleMinutes 校验', () => {
    expect(validateGatewayRoute({ source: '  ', agentId: 'peri' })).toContain('source')
    expect(validateGatewayRoute({ source: 'qq:g', agentId: '' })).toContain('agentId')
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri', idleMinutes: -1 })).toContain('idleMinutes')
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri' })).toBeNull()
  })
})

describe('saveGatewayRouteTransaction', () => {
  it('成功：read → save(合并) → reload → read-back 一致 → ok', async () => {
    const { deps, calls } = createDeps()
    const result = await saveGatewayRouteTransaction({ source: 'qq:group:3', agentId: 'peri' }, deps)
    expect(result.ok).toBe(true)
    expect(calls.join(',')).toMatch(/^read,save:.*qq:group:1.*qq:group:3.*,reload,readback/)
  })

  it('validation 失败不调后端', async () => {
    const { deps, calls } = createDeps()
    const result = await saveGatewayRouteTransaction({ source: '', agentId: 'peri' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('validation')
    expect(calls).toEqual([])
  })

  it('save 失败 → transport', async () => {
    const { deps } = createDeps({ saveRoutes: async () => { throw new Error('save failed') } })
    const result = await saveGatewayRouteTransaction({ source: 'qq:group:3', agentId: 'peri' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('transport')
  })

  it('命令缺失（Command not found）→ blocked「待后端」（G3）', async () => {
    const { deps } = createDeps({
      saveRoutes: async () => { throw new Error('Command not found: update_agents_config') },
    })
    const result = await saveGatewayRouteTransaction({ source: 'qq:group:3', agentId: 'peri' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('blocked')
      expect(result.message).toContain('待后端')
    }
  })

  it('reload 失败 → mismatch（磁盘已更新、运行态仍旧）', async () => {
    const { deps } = createDeps({ reload: async () => { throw new Error('reload failed') } })
    const result = await saveGatewayRouteTransaction({ source: 'qq:group:3', agentId: 'peri' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('mismatch')
  })

  it('read-back 不一致 → mismatch（不伪装成功）', async () => {
    const { deps } = createDeps({ readBackRoutes: async () => EXISTING })
    const result = await saveGatewayRouteTransaction({ source: 'qq:group:3', agentId: 'peri' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('mismatch')
  })
})

describe('validateGatewayRoute I12 W6 presence 校验', () => {
  it('instanceId/profileId/sessionKey 提供空白 → 拒绝', () => {
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri', instanceId: '  ' })).toContain('instanceId')
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri', profileId: '' })).toContain('profileId')
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri', sessionKey: ' ' })).toContain('sessionKey')
  })

  it('reset 非法值 → 拒绝；合法联合通过', () => {
    // 模拟外部/legacy 数据携带非法 reset（静态类型无法表达，运行时必须拒绝）
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri', reset: 'session' as GatewayRouteShape['reset'] })).toContain('reset')
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri', reset: 'daily' })).toBeNull()
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri', reset: 'off' })).toBeNull()
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri', reset: 'idle' })).toBeNull()
  })

  it('legacy 路由（无 instanceId/profile/session）仍可通过（旧配置兼容）', () => {
    expect(validateGatewayRoute({ source: 'qq:g', agentId: 'peri' })).toBeNull()
  })
})

describe('gatewayRouteToConfigEntry I12 W6 yaml 键写回契约', () => {
  it('完整路由 → yaml 键（agent/profile/session/instance/allow_from/reset/idle_minutes）', () => {
    const entry = gatewayRouteToConfigEntry({
      source: 'qq:group:123',
      agentId: 'peri',
      profileId: 'trpg',
      sessionKey: '战役1',
      instanceId: 'qq-bot-1',
      allowFrom: ['member-1'],
      reset: 'daily',
      idleMinutes: 60,
    })
    expect(entry).toEqual({
      source: 'qq:group:123',
      agent: 'peri',
      profile: 'trpg',
      session: '战役1',
      instance: 'qq-bot-1',
      allow_from: ['member-1'],
      reset: 'daily',
      idle_minutes: 60,
    })
  })

  it('可选字段缺省不产出（后端 Option 语义，camelCase 键绝不出现）', () => {
    const entry = gatewayRouteToConfigEntry({ source: 'qq:user:456', agentId: 'hermes' })
    expect(entry).toEqual({ source: 'qq:user:456', agent: 'hermes' })
    expect(JSON.stringify(entry)).not.toMatch(/agentId|profileId|sessionKey|instanceId|allowFrom|idleMinutes/)
  })
})

describe('saveGatewayRouteTransaction I12 W6 round-trip', () => {
  const FULL_ROUTE: GatewayRouteShape = {
    source: 'qq:group:123',
    agentId: 'peri',
    profileId: 'trpg',
    sessionKey: '战役1',
    instanceId: 'qq-bot-1',
    allowFrom: ['member-1', 'member-2'],
    reset: 'daily',
    idleMinutes: 60,
  }

  /** 模拟后端：接受 yaml 键 payload → 写盘 → 重读回 wire camelCase 形状 */
  function backendRoundTripDeps() {
    const payloads: Array<{ routes: Record<string, unknown>[] }> = []
    const deps = {
      readRoutes: async () => [] as GatewayRouteShape[],
      saveRoutes: async (payload: Record<string, unknown>) => {
        const routes = (payload.config as { gateway: { routes: Array<Record<string, unknown>> } }).gateway.routes
        payloads.push({ routes })
      },
      reload: async () => {},
      readBackRoutes: async (): Promise<GatewayRouteShape[]> => {
        // 模拟 EntityBinding serde round-trip：yaml 键 → camelCase wire（与
        // normalizeGatewayStatus 输出一致——每个 yaml 键逐字段映射，无丢失）
        const last = payloads[payloads.length - 1]?.routes ?? []
        return last.map(entry => ({
          source: entry.source as string,
          agentId: entry.agent as string,
          ...(entry.profile !== undefined ? { profileId: entry.profile as string } : {}),
          ...(entry.session !== undefined ? { sessionKey: entry.session as string } : {}),
          ...(entry.instance !== undefined ? { instanceId: entry.instance as string } : {}),
          ...(Array.isArray(entry.allow_from) ? { allowFrom: entry.allow_from as string[] } : {}),
          reset: (entry.reset as GatewayRouteShape['reset']) ?? 'idle',
          ...(entry.idle_minutes !== undefined ? { idleMinutes: entry.idle_minutes as number } : {}),
        }))
      },
      reportError: vi.fn(),
    }
    return { deps, payloads }
  }

  it('全字段路由保存 → payload yaml 键 → 回读 8 字段逐一相等 → ok', async () => {
    const { deps, payloads } = backendRoundTripDeps()
    const result = await saveGatewayRouteTransaction(FULL_ROUTE, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // payload 侧必须携带 instance 键（round-trip 不丢实例绑定）
    const sent = payloads[0].routes[0]
    expect(sent).toEqual({
      source: 'qq:group:123',
      agent: 'peri',
      profile: 'trpg',
      session: '战役1',
      instance: 'qq-bot-1',
      allow_from: ['member-1', 'member-2'],
      reset: 'daily',
      idle_minutes: 60,
    })
    // 回读侧逐字段相等（normalize → shape 全字段一致）
    expect(gatewayRouteFieldsEqual(FULL_ROUTE, result.value[0])).toBe(true)
    expect(result.value[0].instanceId).toBe('qq-bot-1')
  })

  it('回读 instanceId 丢失（normalize/写回静默清空绑定）→ mismatch', async () => {
    const { deps } = backendRoundTripDeps()
    const original = deps.readBackRoutes
    deps.readBackRoutes = async () => {
      const routes = await original()
      return routes.map(route => {
        const { instanceId: _dropped, ...rest } = route
        return rest
      })
    }
    const result = await saveGatewayRouteTransaction(FULL_ROUTE, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('mismatch')
      expect(result.message).toContain('不一致')
    }
  })

  it('回读 profileId 漂移 → mismatch（逐字段比较，非仅 source+agentId）', async () => {
    const { deps } = backendRoundTripDeps()
    const original = deps.readBackRoutes
    deps.readBackRoutes = async () => {
      const routes = await original()
      return routes.map(route => ({ ...route, profileId: 'other-profile' }))
    }
    const result = await saveGatewayRouteTransaction(FULL_ROUTE, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('mismatch')
  })

  it('既有 legacy 路由的 instanceId 随 upsert 写回保留（不因缺字段清空绑定）', async () => {
    const legacy: GatewayRouteShape[] = [
      { source: 'qq:group:1', agentId: 'peri', profileId: 'trpg', sessionKey: '战役1', instanceId: 'qq-bot-1' },
    ]
    const { deps: deps2, payloads } = backendRoundTripDeps()
    deps2.readRoutes = async () => legacy
    await saveGatewayRouteTransaction({ source: 'qq:group:9', agentId: 'hermes', profileId: 'p', sessionKey: 's', instanceId: 'qq-bot-2' }, deps2)
    const sent = payloads[payloads.length - 1].routes
    const legacyEntry = sent.find(entry => entry.source === 'qq:group:1')
    expect(legacyEntry?.instance).toBe('qq-bot-1')
    expect(sent.find(entry => entry.source === 'qq:group:9')?.instance).toBe('qq-bot-2')
  })

  // ── 玉衡 CR-001：比较基线 = upsert 合并条目（生产路径 2 字段输入不得假 mismatch）──

  const EXISTING_FULL: GatewayRouteShape[] = [
    { source: 'qq:group:1', agentId: 'peri', profileId: 'trpg', sessionKey: '战役1', instanceId: 'qq-bot-1', allowFrom: ['m-1'], reset: 'daily', idleMinutes: 60 },
    { source: 'qq:group:2', agentId: 'profile-b', reset: 'daily' },
  ]

  it('CR-001（RED 前）：既有带可选字段路由 + 2 字段同 source 重存 → ok（比较基线应为合并条目）', async () => {
    const { deps, payloads } = backendRoundTripDeps()
    deps.readRoutes = async () => EXISTING_FULL
    const result = await saveGatewayRouteTransaction({ source: 'qq:group:1', agentId: 'peri' }, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // upsert 合并条目必须完整保留既有可选字段（写盘不丢绑定）
    const sent = payloads[0].routes.find(entry => entry.source === 'qq:group:1')
    expect(sent?.instance).toBe('qq-bot-1')
    expect(sent?.profile).toBe('trpg')
    expect(sent?.reset).toBe('daily')
  })

  it('CR-001：2 字段输入重存既有路由，写盘/回读全字段一致（回归不退化）', async () => {
    const { deps, payloads } = backendRoundTripDeps()
    deps.readRoutes = async () => EXISTING_FULL
    await saveGatewayRouteTransaction({ source: 'qq:group:1', agentId: 'peri' }, deps)
    const result = await saveGatewayRouteTransaction({ source: 'qq:group:1', agentId: 'peri' }, deps)
    expect(result.ok).toBe(true)
    expect(payloads[payloads.length - 1].routes.length).toBe(2)
  })

  it('CR-002（RED 前）：source 含前后空白 → 归一化写回并 ok（后端 parse_config 会 trim source）', async () => {
    const { deps, payloads } = backendRoundTripDeps()
    // 模拟后端 parse_config 对 source 执行 trim
    const original = deps.readBackRoutes
    deps.readBackRoutes = async () => {
      const routes = await original()
      return routes.map(route => ({ ...route, source: route.source.trim() }))
    }
    const result = await saveGatewayRouteTransaction(
      { source: '  qq:group:9  ', agentId: 'peri', profileId: 'p', sessionKey: 's', instanceId: 'b-1' },
      deps,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(payloads[0].routes[0].source).toBe('qq:group:9')
  })

  it('CR-002：source 全空白 → validation 拒绝（不触后端）', async () => {
    const { deps, calls } = createDeps()
    const result = await saveGatewayRouteTransaction({ source: '   ', agentId: 'peri' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('validation')
    expect(calls).toEqual([])
  })

  it('CR-001/CR-002 修复后：instanceId 漂移仍必须 mismatch（不放松断言）', async () => {
    const { deps } = backendRoundTripDeps()
    deps.readRoutes = async () => EXISTING_FULL
    const original = deps.readBackRoutes
    deps.readBackRoutes = async () => {
      const routes = await original()
      return routes.map(route => {
        const { instanceId: _dropped, ...rest } = route
        return rest
      })
    }
    const result = await saveGatewayRouteTransaction({ source: 'qq:group:1', agentId: 'peri' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('mismatch')
  })
})

describe('routeSourcePlatform / migrateLegacyRouteBindings（I12 W6 旧 route 迁移）', () => {
  it('routeSourcePlatform 取平台前缀；无前缀返回 null', () => {
    expect(routeSourcePlatform('qq:group:123')).toBe('qq')
    expect(routeSourcePlatform('qq:user:456')).toBe('qq')
    expect(routeSourcePlatform('wechat:group:1')).toBe('wechat')
    expect(routeSourcePlatform('local:gui')).toBe('local')
    expect(routeSourcePlatform('no-colon')).toBeNull()
  })

  const INSTANCES = [
    { id: 'qq-bot-1', platform: 'qq', enabled: true },
    { id: 'qq-bot-2', platform: 'qq', enabled: true },
    { id: 'wx-bot-1', platform: 'wechat', enabled: true },
  ]

  it('平台唯一 enabled instance → 自动补绑定 instanceId', () => {
    const routes: GatewayRouteShape[] = [
      { source: 'wechat:group:1', agentId: 'peri', profileId: 'p', sessionKey: 's' },
    ]
    const migrated = migrateLegacyRouteBindings(routes, INSTANCES)
    expect(migrated[0].instanceId).toBe('wx-bot-1')
  })

  it('平台多 enabled instance → 保持 Unbound（禁止歧义 fallback）', () => {
    const routes: GatewayRouteShape[] = [
      { source: 'qq:group:1', agentId: 'peri', profileId: 'p', sessionKey: 's' },
    ]
    const migrated = migrateLegacyRouteBindings(routes, INSTANCES)
    expect(migrated[0].instanceId).toBeUndefined()
  })

  it('平台零 enabled instance → 保持 Unbound', () => {
    const routes: GatewayRouteShape[] = [
      { source: 'telegram:group:1', agentId: 'peri', profileId: 'p', sessionKey: 's' },
    ]
    const migrated = migrateLegacyRouteBindings(routes, INSTANCES)
    expect(migrated[0].instanceId).toBeUndefined()
  })

  it('已绑定 route 不变（不重复迁移）', () => {
    const routes: GatewayRouteShape[] = [
      { source: 'wechat:group:1', agentId: 'peri', profileId: 'p', sessionKey: 's', instanceId: 'explicit-bot' },
    ]
    const migrated = migrateLegacyRouteBindings(routes, INSTANCES)
    expect(migrated[0].instanceId).toBe('explicit-bot')
  })

  it('无平台前缀 source → 不迁移', () => {
    const routes: GatewayRouteShape[] = [
      { source: 'plain-source', agentId: 'peri', profileId: 'p', sessionKey: 's' },
    ]
    const migrated = migrateLegacyRouteBindings(routes, INSTANCES)
    expect(migrated[0].instanceId).toBeUndefined()
  })
})
