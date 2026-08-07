/**
 * saveGatewayRouteTransaction 行为测试（报告 3.5 / 5B / FE-AUD-004）：
 * upsert by source、validation、save/reload/read-back 失败分类、回读一致才 ok。
 */
import { describe, expect, it, vi } from 'vitest'
import { saveGatewayRouteTransaction, upsertGatewayRoute, validateGatewayRoute, type GatewayRouteShape } from '../saveGatewayRouteTransaction'

const EXISTING: GatewayRouteShape[] = [
  { source: 'qq:group:1', agentId: 'peri', profileId: 'riccati', reset: 'session', idleMinutes: 30, allowFrom: [] },
  { source: 'qq:group:2', agentId: 'serina', profileId: 'riccati', reset: 'session', idleMinutes: 30, allowFrom: [] },
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
