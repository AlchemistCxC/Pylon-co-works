// @vitest-environment jsdom
import { render, waitFor, cleanup } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { createGitStatus, type GitStatusState } from '../useGitStatus.solid.ts'
import type { GitProvider } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { WorkspaceTarget } from '../../../domains/workspace/workspaceTarget.ts'
import { resetStores } from '../../../test/resetStores'

afterEach(() => cleanup())

// 0-C3：createGitStatus 单测（#515 迁移自 useGitStatus.test.tsx，React hook → Solid 实体）
//——拉取/守卫/applyStatus 回填/refresh/目标切换清空语义
//（仅目标切换清空旧数据；手动刷新保留旧数据直至新数据落地，0-A review 反馈修复）。
// 断言改写点登记：
// 1. React Harness 重渲染收集 states[] → 单实例 + 信号驱动（setTargetSignal 切目标）；
//    createGitStatus 每次挂载返回稳定句柄，断言改读访问器（entries()/branchName()/…）。
// 2. act(async () => refresh()) → 直接调用（Solid effect 同步传播）。

vi.mock('../../../app/runtimeError', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))

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

function Harness(props: { target: WorkspaceTarget; provider: GitProvider; onState: (state: GitStatusState) => void }) {
  const state = createGitStatus(() => props.target, () => props.provider)
  props.onState(state)
  return null
}

function renderHarness(initialTarget: WorkspaceTarget, provider: GitProvider) {
  const [targetSignal, setTargetSignal] = createSignal<WorkspaceTarget>(initialTarget)
  let captured: GitStatusState | null = null
  render(() => (
    <Harness
      target={targetSignal()}
      provider={provider}
      onState={state => { captured = state }}
    />
  ))
  return {
    state: () => {
      if (!captured) throw new Error('createGitStatus state has not been captured')
      return captured
    },
    setTarget: setTargetSignal,
  }
}

describe('createGitStatus（0-C3 / issue #289，#515 Solid 形态）', () => {
  beforeEach(() => resetStores())

  it('拉取 status → entries/branchName 落地', async () => {
    const provider: GitProvider = {
      id: 't', canHandle: () => true,
      status: vi.fn().mockResolvedValue(statusOf([{ path: 'a.ts', status: ' M', staged: false }])),
      history: vi.fn(), diff: vi.fn(),
    }
    const harness = renderHarness(target, provider)
    await waitFor(() => expect(harness.state().entries()).toHaveLength(1))
    expect(harness.state().branchName()).toBe('main')
  })

  it('目标切换 → 旧 entries 立即清空；手动 refresh → 旧数据保留至新数据落地', async () => {
    const statusA = vi.fn().mockResolvedValue(statusOf([{ path: 'a.ts', status: ' M', staged: false }]))
    const provider: GitProvider = {
      id: 't', canHandle: () => true,
      status: statusA,
      history: vi.fn(), diff: vi.fn(),
    }
    const harness = renderHarness(target, provider)
    await waitFor(() => expect(harness.state().entries()).toHaveLength(1))

    // 手动 refresh：旧 entries 保留（不清空闪现「无变更」），新数据落地后更新
    harness.state().refresh()
    expect(harness.state().entries()).toHaveLength(1)
    await waitFor(() => expect(statusA.mock.calls.length).toBe(2))

    // 目标切换：旧数据立即清空
    harness.setTarget(otherTarget)
    expect(harness.state().entries()).toEqual([])
    expect(harness.state().branchName()).toBeNull()
  })

  it('status 拒绝 → 分类为 not-repo 错误态', async () => {
    const provider: GitProvider = {
      id: 't', canHandle: () => true,
      status: vi.fn().mockRejectedValue(new Error('fatal: not a git repository')),
      history: vi.fn(), diff: vi.fn(),
    }
    const harness = renderHarness(target, provider)
    await waitFor(() => expect(harness.state().error()).not.toBeNull())
    expect(harness.state().error()!.kind).toBe('not-repo')
  })

  it('applyStatus 回填（写操作结果，不发新请求）', async () => {
    const statusFn = vi.fn().mockResolvedValue(statusOf([]))
    const provider: GitProvider = {
      id: 't', canHandle: () => true,
      status: statusFn,
      history: vi.fn(), diff: vi.fn(),
    }
    const harness = renderHarness(target, provider)
    await waitFor(() => expect(statusFn).toHaveBeenCalled())
    const callsBefore = statusFn.mock.calls.length

    harness.state().applyStatus(statusOf([{ path: 'b.ts', status: 'M ', staged: true }]))
    expect(harness.state().entries()).toEqual([{ path: 'b.ts', status: 'M ', staged: true }])
    expect(statusFn.mock.calls.length).toBe(callsBefore)
  })
})
