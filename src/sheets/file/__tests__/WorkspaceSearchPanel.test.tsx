// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkspaceSearchPanel from '../WorkspaceSearchPanel.tsx'
import type { FileProvider } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { WorkspaceTarget } from '../../../domains/workspace/workspaceTarget.ts'

// 下沉自 scripts/test-workspace-search.mts（P91 A2）：搜索面板接线行为——
// 只经 provider.search 消费正式命令；missing 明确「后端命令不可用」阻塞态；结果经 normalize。

const target: WorkspaceTarget = { sessionId: 's1', agentId: 'peri', source: 'local:x' }

// provider.search 桩返回未归一的原始行（含缺 line / 非对象项），经 cast 绕开 wire 类型
function makeProvider(search: unknown): FileProvider {
  return { search } as unknown as FileProvider
}

describe('WorkspaceSearchPanel 搜索流', () => {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  })

  it('成功：调用 provider.search（去空白查询）并渲染归一结果，点击回传 path/line', async () => {
    const onOpenResult = vi.fn()
    const search = vi.fn(async () => [
      { path: 'src/a.ts', line: 12, lineText: 'const x = 1' },
      { path: 'src/b.ts', lineText: 'no line' },
      { path: '' },
      null,
    ])
    render(<WorkspaceSearchPanel target={target} provider={makeProvider(search)} onOpenResult={onOpenResult} />)
    fireEvent.change(screen.getByLabelText('工作区搜索'), { target: { value: '  const  ' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(search).toHaveBeenCalledWith(target, 'const'))
    // 高亮会把行文本拆进 <mark>，按文件名行定位（a.ts/b.ts 归一保留）
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument())
    expect(screen.getByText('b.ts')).toBeInTheDocument()
    expect(screen.getAllByText('L1').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('a.ts'))
    expect(onOpenResult).toHaveBeenCalledWith('src/a.ts', 12)
  })

  it('命令缺失：明确「后端命令不可用」阻塞态', async () => {
    const search = vi.fn(async () => { throw new Error('Command not found: workspace_search') })
    render(<WorkspaceSearchPanel target={target} provider={makeProvider(search)} onOpenResult={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('工作区搜索'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(screen.getByText(/后端命令不可用/)).toBeInTheDocument())
  })

  it('无 provider 或空查询时不触发搜索', () => {
    const search = vi.fn()
    render(<WorkspaceSearchPanel target={target} provider={null} onOpenResult={vi.fn()} />)
    const submit = screen.getByRole('button', { name: '搜索' })
    expect(submit).toBeDisabled()
    expect(search).not.toHaveBeenCalled()
  })
})
