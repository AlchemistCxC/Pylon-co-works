/**
 * #448 PR4 approvalModeRestore 行为测试——启动顺序反转（#321 决议「收敛到后端权威」）：
 * - 后端持久层在场 → 应用权威值，**不推送本地值**（CLI set 后重启不回滚——漂移路径消除）
 * - 后端从未存过 → localStorage 首次种子（apply + 写穿），只发生一次
 * - 后端不可用 → 降级显示本地值 + 可见上报
 */
import { describe, expect, it, vi } from 'vitest'
import { restoreApprovalModeFromBackendAuthority, type ApprovalModeRestoreDeps } from '../approvalModeRestore'
import type { ApprovalMode } from '../approvalMode'

interface Harness {
  deps: ApprovalModeRestoreDeps
  applied: ApprovalMode[]
  fallbackApplied: ApprovalMode[]
  seeded: ApprovalMode[]
  errors: Array<{ action: string; error: unknown }>
}

function harness(options: {
  persisted: unknown | (() => Promise<unknown>) | 'reject'
  local?: ApprovalMode | null
}): Harness {
  const applied: ApprovalMode[] = []
  const fallbackApplied: ApprovalMode[] = []
  const seeded: ApprovalMode[] = []
  const errors: Array<{ action: string; error: unknown }> = []
  const deps: ApprovalModeRestoreDeps = {
    loadPersisted: () => typeof options.persisted === 'function'
      ? options.persisted()
      : options.persisted === 'reject'
        ? Promise.reject(new Error('user_data_unavailable'))
        : Promise.resolve(options.persisted),
    seedToBackend: mode => { seeded.push(mode); return Promise.resolve() },
    readLocal: () => options.local ?? null,
    apply: mode => { applied.push(mode) },
    applyLocalFallback: mode => { fallbackApplied.push(mode) },
    reportError: (action, error) => { errors.push({ action, error }) },
  }
  return { deps, applied, fallbackApplied, seeded, errors }
}

describe('restoreApprovalModeFromBackendAuthority', () => {
  it('后端持久层在场 → 应用权威值，不种子不推送（CLI set 后重启不回滚）', async () => {
    const h = harness({ persisted: { payload: { mode: 'edit' } }, local: 'auto' })
    await restoreApprovalModeFromBackendAuthority(h.deps)
    expect(h.applied).toEqual(['edit'])
    expect(h.seeded).toEqual([])
    expect(h.fallbackApplied).toEqual([])
    expect(h.errors).toEqual([])
  })

  it('后端从未存过 + 本地有值 → 首次种子：应用本地值并写穿后端', async () => {
    const h = harness({ persisted: null, local: 'bypass' })
    await restoreApprovalModeFromBackendAuthority(h.deps)
    expect(h.applied).toEqual(['bypass'])
    expect(h.seeded).toEqual(['bypass'])
  })

  it('后端从未存过 + 本地无值 → 无操作（双方默认 default 一致）', async () => {
    const h = harness({ persisted: null, local: null })
    await restoreApprovalModeFromBackendAuthority(h.deps)
    expect(h.applied).toEqual([])
    expect(h.seeded).toEqual([])
    expect(h.errors).toEqual([])
  })

  it('后端不可用 → 降级显示本地值 + 可见上报（不抛）', async () => {
    const h = harness({ persisted: 'reject', local: 'auto' })
    await expect(restoreApprovalModeFromBackendAuthority(h.deps)).resolves.toBeUndefined()
    expect(h.fallbackApplied).toEqual(['auto'])
    expect(h.applied).toEqual([])
    expect(h.errors.map(entry => entry.action)).toEqual(['恢复权限模式'])
  })

  it('后端行的 mode 非法（手改 DB）→ 视为从未存过，走种子分支', async () => {
    const h = harness({ persisted: { payload: { mode: 'yolo' } }, local: 'edit' })
    await restoreApprovalModeFromBackendAuthority(h.deps)
    expect(h.applied).toEqual(['edit'])
    expect(h.seeded).toEqual(['edit'])
  })

  it('种子写穿失败 → 本地值仍应用（显示先行），错误不静默', async () => {
    const deps = harness({ persisted: null, local: 'auto' }).deps
    deps.seedToBackend = () => Promise.reject(new Error('db busy'))
    const reportError = vi.fn()
    deps.reportError = reportError
    await expect(restoreApprovalModeFromBackendAuthority(deps)).resolves.toBeUndefined()
    expect(reportError).toHaveBeenCalledTimes(1)
  })
})
