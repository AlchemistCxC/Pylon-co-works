/**
 * ISSUE-13 W3（T13-3）retentionPolicyRepository 测试——Tauri 模式（后端权威源）：
 * - load 读后端 retention_policy_get；无行 → 默认永久保存（不落库）
 * - 损坏/越档 payload → 回退 permanent + corruptWarning（D-15 不静默覆盖）
 * - 后端不可用 → 抛 RetentionPolicyLoadError
 * - save 带 expectedRevision 调 retention_policy_set；conflict 错误透传
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('../../tauri/env', () => ({ IS_TAURI: true }))

import {
  loadRetentionPolicy,
  previewRetentionPolicy,
  pruneRetentionPolicy,
  retentionErrorCode,
  retentionErrorMessage,
  saveRetentionPolicy,
} from '../retentionPolicyRepository'

let fakeInvoke: FakeInvoke

beforeEach(() => {
  fakeInvoke = new FakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
})

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

const row = (revision: number, payload: string) => ({ version: 1, revision, payload })

describe('Tauri 模式（IS_TAURI=true）', () => {
  it('load 读后端权威行（policy + revision）', async () => {
    fakeInvoke.register('retention_policy_get', () => row(3, '{"mode":"by_count","count":5000}'))
    const snap = await loadRetentionPolicy(memoryStorage())
    expect(snap.source).toBe('backend')
    expect(snap.revision).toBe(3)
    expect(snap.policy).toEqual({ mode: 'by_count', count: 5000 })
    expect(snap.corruptWarning).toBeNull()
    expect(fakeInvoke.calls).toContainEqual({ cmd: 'retention_policy_get', args: {} })
  })

  it('load 无行 → 默认永久保存，不落库', async () => {
    fakeInvoke.register('retention_policy_get', () => null)
    const snap = await loadRetentionPolicy(memoryStorage())
    expect(snap.policy).toEqual({ mode: 'permanent' })
    expect(snap.revision).toBeNull()
    expect(snap.corruptWarning).toBeNull()
  })

  it('load 损坏 payload → 回退 permanent + corruptWarning（不静默覆盖）', async () => {
    fakeInvoke.register('retention_policy_get', () => row(2, 'not-json'))
    const snap = await loadRetentionPolicy(memoryStorage())
    expect(snap.policy).toEqual({ mode: 'permanent' })
    expect(snap.revision).toBe(2)
    expect(snap.corruptWarning).toContain('损坏')
  })

  it('load 越档 payload（by_time 缺 days）→ 回退 permanent + corruptWarning', async () => {
    fakeInvoke.register('retention_policy_get', () => row(1, '{"mode":"by_time"}'))
    const snap = await loadRetentionPolicy(memoryStorage())
    expect(snap.policy).toEqual({ mode: 'permanent' })
    expect(snap.corruptWarning).toContain('不可用')
  })

  it('load 后端不可用 → 抛 RetentionPolicyLoadError，message 提取后端文案（CR-001）', async () => {
    fakeInvoke.register('retention_policy_get', () => {
      throw { code: 'retention_unavailable', message: 'db down' }
    })
    await expect(loadRetentionPolicy(memoryStorage())).rejects.toMatchObject({
      message: '读取保留策略失败：db down',
    })
    expect(retentionErrorMessage({ code: 'x', message: '后端文案' })).toBe('后端文案')
    // 无 message 的拒绝对象回退 String（不抛）；真 Error 原样透传
    expect(retentionErrorMessage(new Error('plain'))).toBe('plain')
    expect(retentionErrorMessage({ code: 'x' })).toBeTruthy()
  })

  it('save 带 expectedRevision 调 retention_policy_set（camelCase → snake_case）', async () => {
    fakeInvoke.register('retention_policy_set', () => 4)
    const rev = await saveRetentionPolicy(memoryStorage(), { mode: 'by_time', days: 30 }, 3)
    expect(rev).toBe(4)
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'retention_policy_set',
      args: { json: '{"mode":"by_time","days":30}', expectedRevision: 3 },
    })
  })

  it('无行首写（revision=null）→ expectedRevision 归一为 0（CR-002 首写竞态保护）', async () => {
    fakeInvoke.register('retention_policy_set', () => 1)
    const rev = await saveRetentionPolicy(memoryStorage(), { mode: 'permanent' }, null)
    expect(rev).toBe(1)
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'retention_policy_set',
      args: { json: '{"mode":"permanent"}', expectedRevision: 0 },
    })
  })

  it('conflict 错误透传，retentionErrorCode 识别', async () => {
    fakeInvoke.register('retention_policy_set', () => {
      throw { code: 'retention_revision_conflict', message: '期望 3，实际 2' }
    })
    await expect(
      saveRetentionPolicy(memoryStorage(), { mode: 'permanent' }, 3),
    ).rejects.toMatchObject({ code: 'retention_revision_conflict' })
    expect(retentionErrorCode({ code: 'retention_revision_conflict' })).toBe('retention_revision_conflict')
    expect(retentionErrorCode(new Error('x'))).toBeUndefined()
  })

  it('previewRetentionPolicy 调 retention_preview（I13-W4）', async () => {
    fakeInvoke.register('retention_preview', () => ({
      totalCandidates: 2, affectedSessions: 1, oldestDeletedAt: 1_700_000_000_000,
      perSession: [{ sessionId: 's1', count: 2 }],
    }))
    const result = await previewRetentionPolicy({ mode: 'by_time', days: 30 })
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'retention_preview',
      args: { policy: { mode: 'by_time', days: 30 } },
    })
    expect(result.totalCandidates).toBe(2)
    expect(result.affectedSessions).toBe(1)
  })

  it('pruneRetentionPolicy 带 expectedPolicyRevision（I13-W4）', async () => {
    fakeInvoke.register('retention_prune', () => ({
      totalCandidates: 2, affectedSessions: 1, oldestDeletedAt: null,
      perSession: [],
    }))
    const result = await pruneRetentionPolicy({ mode: 'by_count', count: 100 }, 3)
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'retention_prune',
      args: { policy: { mode: 'by_count', count: 100 }, expectedPolicyRevision: 3 },
    })
    expect(result.oldestDeletedAt).toBeNull()
  })

  it('stale 错误透传（retention_stale_preview）', async () => {
    fakeInvoke.register('retention_prune', () => {
      throw { code: 'retention_stale_preview', message: '策略已变化' }
    })
    await expect(
      pruneRetentionPolicy({ mode: 'by_time', days: 30 }, 1),
    ).rejects.toMatchObject({ code: 'retention_stale_preview' })
  })
})
