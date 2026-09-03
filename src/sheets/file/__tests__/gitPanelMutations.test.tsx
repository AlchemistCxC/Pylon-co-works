// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitOperationResult, GitStatusWithBranch } from '../../../infrastructure/tauri/gitContracts.ts'
import type { GitProvider } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { WorkspaceTarget } from '../../../domains/workspace/workspaceTarget.ts'
import GitPanel from '../GitPanel.tsx'
import { reportRuntimeError } from '../../../runtimeError.ts'

vi.mock('../../../runtimeError', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))

const target: WorkspaceTarget = {
  sessionId: 'session-a',
  agentId: 'agent-a',
  source: 'source-a',
  legacyWorkdir: 'C:/repo',
}

const branch = { branch: 'main', detached: false, head: 'abc123' }
const status = (entries: GitStatusWithBranch['entries'], name = 'main'): GitStatusWithBranch => ({
  branch: { ...branch, branch: name },
  entries,
})
const result = (next: GitStatusWithBranch, summary: string): GitOperationResult => ({ status: next, summary })

function provider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    id: 'test.git',
    canHandle: () => true,
    status: vi.fn().mockResolvedValue(status([{ path: 'src/a.ts', status: ' M', staged: false }])),
    history: vi.fn().mockResolvedValue([]),
    diff: vi.fn().mockResolvedValue('diff'),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('GitPanel 写操作', () => {
  beforeEach(() => vi.clearAllMocks())

  it('按文件暂存并用操作回执原子刷新分区', async () => {
    const stage = vi.fn().mockResolvedValue(result(status([{ path: 'src/a.ts', status: 'M ', staged: true }]), '已暂存'))
    const git = provider({ stage })
    render(<GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '暂存 src/a.ts' }))
    await waitFor(() => expect(stage).toHaveBeenCalledWith(target, ['src/a.ts']))
    expect(await screen.findByRole('status')).toHaveTextContent('已暂存')
    expect(within(screen.getByText('STAGED').closest('section')!).getByTitle('src/a.ts')).toBeTruthy()
  })

  it('提交只在有暂存内容且说明非空时启用，并刷新历史', async () => {
    const initial = status([{ path: 'a.ts', status: 'M ', staged: true }])
    const commit = vi.fn().mockResolvedValue(result(status([]), '提交成功'))
    const history = vi.fn().mockResolvedValue([{ hash: 'abcdef123', author: 'Pylon', date: 1, subject: 'done' }])
    const git = provider({ status: vi.fn().mockResolvedValue(initial), commit, history })
    render(<GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    const submit = await screen.findByRole('button', { name: '提交 1 项变更' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('提交说明'), { target: { value: 'describe change' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(commit).toHaveBeenCalledWith(target, 'describe change'))
    await screen.findByText('done')
    expect(screen.getByLabelText('提交说明')).toHaveValue('')
  })

  it('创建/切换分支与 pull/push 都经 provider 能力调用', async () => {
    const createBranch = vi.fn().mockResolvedValue(result(status([], 'feature/gui'), '已创建分支'))
    const switchBranch = vi.fn().mockResolvedValue(result(status([], 'main'), '已切换分支'))
    const pull = vi.fn().mockResolvedValue(result(status([]), '已经是最新版本'))
    const push = vi.fn().mockResolvedValue(result(status([]), '推送完成'))
    const git = provider({ createBranch, switchBranch, pull, push })
    render(<GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '分支' }))
    fireEvent.change(screen.getByLabelText('分支名称'), { target: { value: 'feature/gui' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并切换' }))
    await waitFor(() => expect(createBranch).toHaveBeenCalledWith(target, 'feature/gui'))
    await screen.findByText('feature/gui')

    fireEvent.click(screen.getByRole('button', { name: '拉取' }))
    await waitFor(() => expect(pull).toHaveBeenCalledWith(target))
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith(target))

    fireEvent.click(screen.getByRole('button', { name: '分支' }))
    fireEvent.change(screen.getByLabelText('分支名称'), { target: { value: 'main' } })
    fireEvent.click(screen.getByRole('button', { name: '切换已有分支' }))
    await waitFor(() => expect(switchBranch).toHaveBeenCalledWith(target, 'main'))
  })

  it('只读 provider 不渲染写入口，diff 行为保持可用', async () => {
    const onOpenDiff = vi.fn()
    render(<GitPanel target={target} provider={provider()} onOpenDiff={onOpenDiff} />)
    fireEvent.click(await screen.findByTitle('src/a.ts'))
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts', false)
    expect(screen.queryByLabelText('提交说明')).toBeNull()
    expect(screen.queryByRole('button', { name: '推送' })).toBeNull()
  })

  it('切换 workspace 后忽略旧 Git 写操作的迟到失败', async () => {
    const operation = deferred<GitOperationResult>()
    const stage = vi.fn(() => operation.promise)
    const git = provider({ stage })
    const { rerender } = render(<GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '暂存 src/a.ts' }))

    const nextTarget = { ...target, sessionId: 'session-b', source: 'source-b', legacyWorkdir: 'C:/repo-b' }
    rerender(<GitPanel target={nextTarget} provider={git} onOpenDiff={vi.fn()} />)
    operation.reject(new Error('stale workspace failure'))
    await waitFor(() => expect(screen.getByText('WORKING TREE')).toBeTruthy())

    expect(screen.queryByText('stale workspace failure')).toBeNull()
    expect(reportRuntimeError).not.toHaveBeenCalledWith('暂存', expect.anything())
  })

  it('切换 workspace 会清空提交与分支草稿，避免把 A 的写入意图带到 B', async () => {
    const git = provider({
      status: vi.fn().mockResolvedValue(status([{ path: 'a.ts', status: 'M ', staged: true }])),
      commit: vi.fn().mockResolvedValue(result(status([]), 'ok')),
      createBranch: vi.fn().mockResolvedValue(result(status([]), 'ok')),
    })
    const { rerender } = render(<GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)
    await screen.findByRole('button', { name: '提交 1 项变更' })
    fireEvent.change(screen.getByLabelText('提交说明'), { target: { value: 'workspace a commit' } })
    fireEvent.click(screen.getByRole('button', { name: '分支' }))
    fireEvent.change(screen.getByLabelText('分支名称'), { target: { value: 'workspace-a-branch' } })

    const nextTarget = { ...target, sessionId: 'session-b', source: 'source-b', legacyWorkdir: 'C:/repo-b' }
    rerender(<GitPanel target={nextTarget} provider={git} onOpenDiff={vi.fn()} />)

    await waitFor(() => expect(screen.getByLabelText('提交说明')).toHaveValue(''))
    expect(screen.queryByDisplayValue('workspace-a-branch')).toBeNull()
  })
})
