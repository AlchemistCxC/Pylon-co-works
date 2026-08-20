/**
 * ISSUE-13 W6（T13-7）保留策略进导出——Tauri 模式聚合后端权威 payload：
 * - buildExportPayloadAsync 经 backend.loadRetention 聚合 retention_policy_get payload
 * - 后端无策略 → 不写入 data
 * - overwriteRetentionPolicy 盲写（导入覆盖，expectedRevision=null）
 * - loadRetentionPolicyPayload 返回原始 payload（不解析/不回退）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
vi.mock('../infrastructure/tauri/env', () => ({ IS_TAURI: true }))

import { buildExportPayloadAsync } from '../configExportImport'
import { RETENTION_STORAGE_KEY } from '../components/settings/historyRetentionPolicy'
import {
  loadRetentionPolicyPayload,
  overwriteRetentionPolicy,
  syncImportedRetentionPolicy,
} from '../retentionPolicyRepository'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(seed))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('I13-W6 Tauri 导出聚合保留策略', () => {
  beforeEach(() => { invokeMock.mockReset() })

  it('buildExportPayloadAsync 经 loadRetention 聚合后端 payload', async () => {
    const retentionPayload = '{"mode":"by_time","days":180}'
    invokeMock.mockResolvedValueOnce({ version: 1, revision: 4, payload: retentionPayload })  // retention_policy_get
    const json = await buildExportPayloadAsync(memoryStorage(), {
      loadProfiles: async () => null,
      loadSessions: async () => null,
      loadRetention: async () => {
        const payload = await loadRetentionPolicyPayload()
        return payload ? { payload } : null
      },
    })
    const data = (JSON.parse(json) as { data: Record<string, string> }).data
    expect(data[RETENTION_STORAGE_KEY]).toBe(retentionPayload)
    expect(invokeMock.mock.calls[0][0]).toBe('retention_policy_get')
  })

  it('后端无策略 → 不写入 data（localStorage 无该 key 则缺省）', async () => {
    invokeMock.mockResolvedValueOnce(null)
    const json = await buildExportPayloadAsync(memoryStorage(), {
      loadProfiles: async () => null,
      loadSessions: async () => null,
      loadRetention: async () => {
        const payload = await loadRetentionPolicyPayload()
        return payload ? { payload } : null
      },
    })
    const data = (JSON.parse(json) as { data: Record<string, string> }).data
    expect(data[RETENTION_STORAGE_KEY]).toBeUndefined()
  })

  it('overwriteRetentionPolicy 盲写（expectedRevision=null，导入覆盖语义）', async () => {
    invokeMock.mockResolvedValueOnce(5)
    const rev = await overwriteRetentionPolicy({ mode: 'by_count', count: 5000 })
    expect(rev).toBe(5)
    expect(invokeMock).toHaveBeenCalledWith('retention_policy_set', {
      json: '{"mode":"by_count","count":5000}',
      expectedRevision: null,
    })
  })

  it('syncImportedRetentionPolicy：导入不含策略 key → 不写穿后端（CR-001）', async () => {
    // localStorage 残留旧策略值 + 导入 keys 不含策略 key → 不得盲写覆盖后端
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: '{"mode":"by_time","days":180}' })
    await syncImportedRetentionPolicy(storage, ['pylon-theme'])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('syncImportedRetentionPolicy：导入含策略 key → 盲写后端权威', async () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: '{"mode":"by_count","count":1000}' })
    invokeMock.mockResolvedValueOnce(3)
    await syncImportedRetentionPolicy(storage, ['pylon-theme', RETENTION_STORAGE_KEY])
    expect(invokeMock).toHaveBeenCalledWith('retention_policy_set', {
      json: '{"mode":"by_count","count":1000}',
      expectedRevision: null,
    })
  })

  it('syncImportedRetentionPolicy：导入含 key 但本地无值 → 不写穿', async () => {
    await syncImportedRetentionPolicy(memoryStorage(), [RETENTION_STORAGE_KEY])
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
