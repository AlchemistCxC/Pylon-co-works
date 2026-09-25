// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitStatus } from '../useGitStatus'
import type { GitProvider } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { WorkspaceTarget } from '../../../domains/workspace/workspaceTarget.ts'
import { resetStores } from '../../../test/resetStores'

// 0-C3：useGitStatus 单测——拉取/守卫/applyStatus 回填/refresh/目标切换清空语义
//（仅目标切换清空旧数据；手动刷新保留旧数据直至新数据落地，0-A review 反馈修复）。

vi.mock('../../../runtimeError', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))

const target: WorkspaceTarget = {
  sessionId: 'session-a',
  agentId: 'agent-a',
  source: 'source-a',
  legacyWorkdir: 'C:/repo',
}

const otherTarget: WorkspaceTarget = { ...target, source: 'source-b' }

const branch = { branch: 'main', detached: false, head: 'abc' }

function statusOf(entries: Array<{ path: string; status: string; staged: boolean }>) {
  return { branch, entries }
}

function Harness({ target: t, provider: p, onState }: { target: WorkspaceTarget; provider: GitProvider; onState: (state: ReturnType<typeof useGitStatus>) => void }) {
  const state = useGitStatus(t, p)
  onState(state)
  return null
}

describe('useGitStatus（0-C3 / issue #289）', () => {
  beforeEach(() => resetStores())

  it('拉取 status → entries/branchName 落地', async () => {
    const provider: GitProvider = {
      id: 't', canHandle: () => true,
      status: vi.fn().mockResolvedValue(statusOf([{ path: 'a.ts', status: ' M', staged: false }])),
      history: vi.fn(), diff: vi.fn(),
    }
    const states: Array<ReturnType<typeof useGitStatus>> = []
    render(<Harness target={target} provider={provider} onState={s => states.push(s)} />)
    await waitFor(() => expect(states[states.length - 1]!.entries).toHaveLength(1))
    expect(states[states.length - 1]!.branchName).toBe('main')
  })

  it('目标切换 → 旧 entries 立即清空；手动 refresh → 旧数据保留至新数据落地', async () => {
    const statusA = vi.fn().mockResolvedValue(statusOf([{ path: 'a.ts', status: ' M', staged: false }]))
    const provider: GitProvider = {
      id: 't', canHandle: () => true,
      status: statusA,
      history: vi.fn(), diff: vi.fn(),
    }
    const states: Array<ReturnType<typeof useGitStatus>> = []
    const { rerender } = render(<Harness target={target} provider={provider} onState={s => states.push(s)} />)
    await waitFor(() => expect(states[states.length - 1]!.entries).toHaveLength(1))

    // 手动 refresh：旧 entries 保留（不清空闪现「无变更」），新数据落地后更新
    await act(async () => { states[states.length - 1]!.refresh() })
    expect(states[states.length - 1]!.entries).toHaveLength(1)
    await waitFor(() => expect(statusA.mock.calls.length).toBe(2))

    // 目标切换：旧数据立即清空
    rerender(<Harness target={otherTarget} provider={provider} onState={s => states.push(s)} />)
    expect(states[states.length - 1]!.entries).toEqual([])
    expect(states[states.length - 1]!.branchName).toBeNull()
  })

  it('status 拒绝 → 分类为 not-repo 错误态', async () => {
    const provider: GitProvider = {
      id: 't', canHandle: () => true,
      status: vi.fn().mockRejectedValue(new Error('fatal: not a git repository')),
      history: vi.fn(), diff: vi.fn(),
    }
    const states: Array<ReturnType<typeof useGitStatus>> = []
    render(<Harness target={target} provider={provider} onState={s => states.push(s)} />)
    await waitFor(() => expect(states[states.length - 1]!.error).not.toBeNull())
    expect(states[states.length - 1]!.error!.kind).toBe('not-repo')
  })

  it('applyStatus 回填（写操作结果，不发新请求）', async () => {
    const statusFn = vi.fn().mockResolvedValue(statusOf([]))
    const provider: GitProvider = {
      id: 't', canHandle: () => true,
      status: statusFn,
      history: vi.fn(), diff: vi.fn(),
    }
    const states: Array<ReturnType<typeof useGitStatus>> = []
    render(<Harness target={target} provider={provider} onState={s => states.push(s)} />)
    await waitFor(() => expect(statusFn).toHaveBeenCalled())
    const callsBefore = statusFn.mock.calls.length

    await act(async () => {
      states[states.length - 1]!.applyStatus(statusOf([{ path: 'b.ts', status: 'M ', staged: true }]))
    })
    expect(states[states.length - 1]!.entries).toEqual([{ path: 'b.ts', status: 'M ', staged: true }])
    expect(statusFn.mock.calls.length).toBe(callsBefore)
  })
})
