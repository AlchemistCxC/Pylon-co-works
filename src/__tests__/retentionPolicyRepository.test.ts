/**
 * ISSUE-13 W3（T13-3）retentionPolicyRepository 测试——browser 模式（无后端）：
 * - load 读 localStorage（既有行为），无 key 回退永久保存
 * - save 写 localStorage 并返回 null revision（不经 invoke）
 * Tauri 模式（后端权威读/写/损坏回退/conflict）见 retentionPolicyRepository.tauri.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { loadRetentionPolicy, previewRetentionPolicy, pruneRetentionPolicy, saveRetentionPolicy } from '../retentionPolicyRepository'
import { RETENTION_STORAGE_KEY } from '../components/settings/historyRetentionPolicy'

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

describe('browser 模式（IS_TAURI=false 默认）', () => {
  beforeEach(() => { invokeMock.mockReset() })

  it('load 读 localStorage；无 key 回退永久保存', async () => {
    const snap = await loadRetentionPolicy(memoryStorage())
    expect(snap.source).toBe('local')
    expect(snap.revision).toBeNull()
    expect(snap.policy).toEqual({ mode: 'permanent' })
    expect(snap.corruptWarning).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('load 读 localStorage 既有策略', async () => {
    const snap = await loadRetentionPolicy(memoryStorage({
      [RETENTION_STORAGE_KEY]: '{"mode":"by_count","count":1000}',
    }))
    expect(snap.policy).toEqual({ mode: 'by_count', count: 1000 })
    expect(snap.source).toBe('local')
  })

  it('save 写 localStorage 并返回 null revision', async () => {
    const storage = memoryStorage()
    const rev = await saveRetentionPolicy(storage, { mode: 'by_time', days: 90 }, null)
    expect(rev).toBeNull()
    expect(storage.getItem(RETENTION_STORAGE_KEY)).toContain('by_time')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('preview/prune 需 Tauri 后端（browser 模式抛错，不触发任何删除）', async () => {
    await expect(previewRetentionPolicy({ mode: 'by_time', days: 30 })).rejects.toThrow(/Tauri 后端/)
    await expect(pruneRetentionPolicy({ mode: 'by_time', days: 30 }, null)).rejects.toThrow(/Tauri 后端/)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
