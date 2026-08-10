// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ViewsPanel, { formatTouchTime } from '../ViewsPanel'
import { useWorkspaceStore } from '../../../workspaceStore'
import { resetStores } from '../../../test/resetStores'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

function touched(path: string, toolKind: string, at: number) {
  return { source: 'ws-a', path, toolKind, at }
}

describe('ViewsPanel 只消费 touchedFiles（去 Git 化）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
  })

  it('渲染 Agent 最近触碰文件（path/toolKind/时间），最新在前', () => {
    useWorkspaceStore.setState({
      touchedFiles: {
        'ws-a': [touched('src/old.ts', 'Edit', 1000), touched('src/new.ts', 'Write', 2000)],
      },
    })
    const { container } = render(<ViewsPanel source="ws-a" onOpenFile={vi.fn()} />)
    expect(screen.getByText('src/new.ts')).toBeTruthy()
    expect(screen.getByText('src/old.ts')).toBeTruthy()
    expect(screen.getByText('Write')).toBeTruthy()
    const paths = Array.from(container.querySelectorAll('.file-view-path')).map(el => el.textContent)
    expect(paths).toEqual(['src/new.ts', 'src/old.ts'])
  })

  it('点击 touched file 行调用 onOpenFile(path) 进入普通文件视图', () => {
    useWorkspaceStore.setState({
      touchedFiles: { 'ws-a': [touched('src/a.ts', 'Edit', 1000)] },
    })
    const onOpenFile = vi.fn()
    render(<ViewsPanel source="ws-a" onOpenFile={onOpenFile} />)
    screen.getByText('src/a.ts').closest('button')!.click()
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('不调用 git_status / 任何后端命令（SCM 独占 Git）', () => {
    useWorkspaceStore.setState({
      touchedFiles: { 'ws-a': [touched('src/a.ts', 'Edit', 1000)] },
    })
    render(<ViewsPanel source="ws-a" onOpenFile={vi.fn()} />)
    expect(invoke).not.toHaveBeenCalled()
    expect(invoke.mock.calls.flat().filter(call => call === 'git_status')).toEqual([])
  })

  it('无 source → 显示选择会话引导', () => {
    render(<ViewsPanel source={null} onOpenFile={vi.fn()} />)
    expect(screen.getByText(/选择会话/)).toBeTruthy()
  })

  it('有 source 但无触碰文件 → 空提示', () => {
    render(<ViewsPanel source="ws-b" onOpenFile={vi.fn()} />)
    expect(screen.getByText(/尚未修改文件/)).toBeTruthy()
  })

  it('formatTouchTime 输出可读时间', () => {
    const out = formatTouchTime(0)
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
  })
})
