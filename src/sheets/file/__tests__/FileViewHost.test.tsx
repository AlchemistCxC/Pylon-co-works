// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FileViewHost from '../FileViewHost'
import { fileTabKey, type FileTabRecord } from '../fileSheetState'
import { resetStores } from '../../../test/resetStores'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../../components/chat/codeHighlight', () => ({ highlightCode: vi.fn().mockResolvedValue(null) }))

function readTextResult(content: string) {
  return { relativePath: 'src/a.ts', content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

const DIFF_OUTPUT = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\nexport const x = 1\n-export const y = 2\n+export const y = 3'

const fileTab: FileTabRecord = { path: 'src/a.ts', mode: 'file' }
const diffTab: FileTabRecord = { path: 'src/a.ts', mode: 'diff', staged: true }

function fileViewOf(container: HTMLElement): Element | null {
  return container.querySelector('.file-tab-view')
}

describe('FileViewHost 统一 file/diff 宿主（D-03/D-04）', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'git_diff') return Promise.resolve(DIFF_OUTPUT)
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
  })

  it('file 模式：渲染 FileTabView + 发令栏 + 状态栏，read 经 typed client 带 source/相对路径', async () => {
    const { container } = render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await waitFor(() => expect(fileViewOf(container)).not.toBeNull())
    expect(fileViewOf(container)?.getAttribute('data-path')).toBe('src/a.ts')
    expect(invoke).toHaveBeenCalledWith('read_workspace_text', { source: 'ws-a', relativePath: 'src/a.ts' })
    expect(screen.getByText('const x = 1')).toBeTruthy()
    expect(screen.getByText('1 行')).toBeTruthy()
    expect(screen.getAllByText('ws-a').length).toBeGreaterThan(0)
  })

  it('diff 模式：渲染 DiffView 复用 DiffCard，git_diff 带 source/path/staged', async () => {
    render(<FileViewHost source="ws-a" tab={diffTab} onCloseTab={vi.fn()} />)
    await screen.findByText('变更预览')
    expect(screen.getByText('src/a.ts（staged）')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('git_diff', { source: 'ws-a', path: 'src/a.ts', staged: true })
  })

  it('同路径 file↔diff 切换不串 mode（关闭/切换不互相覆盖）', async () => {
    const { container, rerender } = render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await waitFor(() => expect(fileViewOf(container)).not.toBeNull())
    rerender(<FileViewHost source="ws-a" tab={diffTab} onCloseTab={vi.fn()} />)
    await screen.findByText('变更预览')
    expect(fileViewOf(container)).toBeNull()
    expect(screen.queryByText('const x = 1')).toBeNull()
    rerender(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await waitFor(() => expect(fileViewOf(container)).not.toBeNull())
    expect(screen.queryByText('变更预览')).toBeNull()
  })

  it('diff 关闭按钮以 mode-key 回调 onCloseTab', async () => {
    const onCloseTab = vi.fn()
    render(<FileViewHost source="ws-a" tab={diffTab} onCloseTab={onCloseTab} />)
    await screen.findByText('变更预览')
    fireEvent.click(screen.getByLabelText('关闭 diff'))
    expect(onCloseTab).toHaveBeenCalledWith(fileTabKey(diffTab))
  })

  it('无活动 tab → 空态引导卡片', () => {
    const { container } = render(<FileViewHost source="ws-a" tab={null} onCloseTab={vi.fn()} />)
    expect(screen.getByText('打开一个文件开始阅读')).toBeTruthy()
    expect(container.querySelector('.file-empty-card')).not.toBeNull()
  })

  it('source 清空 → 重置瞬态编辑器状态（行数归零，视图提示未指向会话）', async () => {
    const { container, rerender } = render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('1 行')
    rerender(<FileViewHost source={null} tab={fileTab} onCloseTab={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByText('未指向会话').length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.getByText('0 行')).toBeTruthy())
    expect(fileViewOf(container)).not.toBeNull()
  })
})
