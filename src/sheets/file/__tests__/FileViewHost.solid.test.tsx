// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import FileViewHost from '../FileViewHost.solid.tsx'
import { fileTabKey, type FileTabRecord } from '../fileSheetState'
import { resetStores } from '../../../test/resetStores'
import { fileEditorEditable, waitForFileEditor } from './codeMirrorTestUtils.solid.ts'

afterEach(() => cleanup())

// #515：迁移自 FileViewHost.test.tsx（React RTL → Solid 实体直连）。
// 断言改写点登记：
// 1. render(<JSX/>) → render(() => JSX)；
// 2. rerender(nextProps) → 信号驱动（setTab/setSource 切换，等价 React 父组件重渲染）；
// 3. act() 包装退役（Solid 信号→effect 同步传播，waitFor 兜底收敛）。
// 其余断言集与 DOM 契约不变。

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
vi.mock('../../../domains/chat/codeHighlight', () => ({ highlightCode: vi.fn().mockResolvedValue(null) }))

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

  it('file 模式：打开默认可写（ADR-0023）；read 经 typed client 带 source/相对路径', async () => {
    const { container } = render(() => <FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    // 挂载与首读完成是两拍渲染：只等元素存在会在 data-path 尚未落入 DOM 时断言（P91 C 批退役 retry 后暴露的游走 flake）。
    await waitFor(() => {
      expect(fileViewOf(container)?.getAttribute('data-path')).toBe('src/a.ts')
      expect(invoke).toHaveBeenCalledWith('read_workspace_text', { source: 'ws-a', relativePath: 'src/a.ts' })
    })
    const editor = await waitForFileEditor('const x = 1')
    // Syntax highlighting can split a line across spans; assert the visible editor text.
    // （#521 冲突解：移植 Codex 侧对脆性断言的修复——高亮拆 span 后 getByText 匹配不到）
    expect(editor.contentDOM).toHaveTextContent('const x = 1')
    expect(fileEditorEditable()).toBe(true)
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByText('编辑中')).toBeNull()
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    expect(screen.getByText('1 行')).toBeTruthy()
    expect(screen.getAllByText('ws-a').length).toBeGreaterThan(0)
  })


  it('diff 模式：渲染 DiffView 复用 DiffCard，git_diff 带 source/path/staged', async () => {
    render(() => <FileViewHost source="ws-a" tab={diffTab} onCloseTab={vi.fn()} />)
    await screen.findByText('变更预览')
    expect(screen.getByText('src/a.ts（staged）')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('git_diff', { source: 'ws-a', path: 'src/a.ts', staged: true })
  })

  it('同路径 file↔diff 切换不串 mode（关闭/切换不互相覆盖）', async () => {
    const [tabSignal, setTabSignal] = createSignal<FileTabRecord>(fileTab)
    const { container } = render(() => <FileViewHost source="ws-a" tab={tabSignal()} onCloseTab={vi.fn()} />)
    await waitFor(() => expect(fileViewOf(container)).not.toBeNull())
    setTabSignal(diffTab)
    await screen.findByText('变更预览')
    expect(fileViewOf(container)).toBeNull()
    expect(screen.queryByText('const x = 1')).toBeNull()
    setTabSignal(fileTab)
    await waitFor(() => expect(fileViewOf(container)).not.toBeNull())
    expect(screen.queryByText('变更预览')).toBeNull()
  })

  it('diff 关闭按钮以 mode-key 回调 onCloseTab', async () => {
    const onCloseTab = vi.fn()
    render(() => <FileViewHost source="ws-a" tab={diffTab} onCloseTab={onCloseTab} />)
    await screen.findByText('变更预览')
    fireEvent.click(screen.getByLabelText('关闭 diff'))
    expect(onCloseTab).toHaveBeenCalledWith(fileTabKey(diffTab))
  })

  it('无活动 tab → 空态引导卡片', () => {
    const { container } = render(() => <FileViewHost source="ws-a" tab={null} onCloseTab={vi.fn()} />)
    expect(screen.getByText('打开一个文件开始阅读')).toBeTruthy()
    expect(container.querySelector('.file-empty-card')).not.toBeNull()
  })

  it('source 清空 → 重置瞬态编辑器状态（行数归零，视图提示未指向会话）', async () => {
    const [sourceSignal, setSourceSignal] = createSignal<string | null>('ws-a')
    const { container } = render(() => <FileViewHost source={sourceSignal()} tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('1 行')
    setSourceSignal(null)
    await waitFor(() => expect(screen.getAllByText('未指向会话').length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.getByText('0 行')).toBeTruthy())
    expect(fileViewOf(container)).not.toBeNull()
  })
})
