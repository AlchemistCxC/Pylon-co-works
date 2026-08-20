/**
 * I14-W8 配置导入导出扩展测试：
 * - buildExportPayloadAsync：Tauri 模式后端 envelope 覆盖 localStorage（权威源）；
 *   browser 模式（无 backend）与原 buildExportPayload 等价
 * - preflightImportPayload：profiles/sessions 值结构校验——损坏拒绝、legacy 形状兼容
 */
import { describe, expect, it } from 'vitest'
import { buildExportPayload, buildExportPayloadAsync, preflightImportPayload } from '../configExportImport'
import { PROFILE_STORAGE_KEY } from '../profilePersistence'
import { SESSION_STORAGE_KEY } from '../sessionPersistence'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
  }
}

describe('I14-W8 buildExportPayloadAsync', () => {
  it('Tauri 后端 envelope 覆盖 localStorage 值（后端为权威源）', async () => {
    const storage = memoryStorage({
      'pylon-theme': '{"theme":1}',
      [PROFILE_STORAGE_KEY]: '{"version":1,"profiles":[{"id":"local","name":"L"}],"activeProfileId":"local"}',
    })
    const json = await buildExportPayloadAsync(storage, {
      loadProfiles: async () => ({ version: 1, profiles: [{ id: 'backend', name: 'B' }], activeProfileId: 'backend' }),
      loadSessions: async () => null,
    })
    const envelope = JSON.parse(json) as { data: Record<string, string> }
    expect(envelope.data[PROFILE_STORAGE_KEY]).toContain('"backend"')
    expect(envelope.data[PROFILE_STORAGE_KEY]).not.toContain('"local"')
    expect(envelope.data['pylon-theme']).toBe('{"theme":1}')
    // 后端无 sessions → 不覆盖（localStorage 有则保留、无则缺省）
    expect(envelope.data[SESSION_STORAGE_KEY]).toBeUndefined()
  })

  it('browser 模式（无 backend）与原 buildExportPayload 等价', async () => {
    const storage = memoryStorage({
      'pylon-theme': '{"x":1}',
      [PROFILE_STORAGE_KEY]: '{"version":1,"profiles":[{"id":"p","name":"P"}],"activeProfileId":"p"}',
    })
    // 确定性比较：两份独立生成的 envelope 的 exportedAt（各自 new Date）跨毫秒边界会不等——
    // 比较 data（配置值）而非全字符串（TEST-001 修复；TEST-002：cast 类型含 app 避免 TS2339）
    const a = JSON.parse(await buildExportPayloadAsync(storage)) as { app: string; data: Record<string, string> }
    const b = JSON.parse(buildExportPayload(storage)) as { app: string; data: Record<string, string> }
    expect(a.data).toEqual(b.data)
    expect(a.app).toBe('pylon')
  })
})

describe('I14-W8 preflight envelope 值校验', () => {
  const envelope = (data: Record<string, string>) =>
    JSON.stringify({ app: 'pylon', version: 1, exportedAt: 'x', data })

  it('损坏 profiles 值（非 JSON）拒绝', () => {
    const result = preflightImportPayload(envelope({ [PROFILE_STORAGE_KEY]: '{bad json' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Profile')
  })

  it('损坏 sessions 值（缺 id）拒绝', () => {
    const result = preflightImportPayload(envelope({
      [SESSION_STORAGE_KEY]: '{"version":2,"sessions":[{"name":"x"}]}',
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Session')
  })

  it('legacy 形状兼容（v1 会话无 agentId 但 id 齐全）', () => {
    const result = preflightImportPayload(envelope({
      [SESSION_STORAGE_KEY]: '{"version":2,"sessions":[{"id":"s1","name":"x","source":"local:a"}]}',
    }))
    expect(result.ok).toBe(true)
  })

  it('合法 profiles/sessions 通过（旧 envelope 兼容窗口）', () => {
    const result = preflightImportPayload(envelope({
      [PROFILE_STORAGE_KEY]: '{"version":1,"profiles":[{"id":"p1","name":"P","persona":"p","model":"m"}],"activeProfileId":"p1"}',
      [SESSION_STORAGE_KEY]: '{"version":2,"sessions":[{"id":"s1","agentId":"peri","name":"S"}]}',
    }))
    expect(result.ok).toBe(true)
  })
})
