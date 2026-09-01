// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import FileTabView from '../FileTabView'
import { useWorkspaceStore, touchedFileVersionKey } from '../../../workspaceStore'
import { resetStores } from '../../../test/resetStores'
import { fileEditorView, replaceFileEditorValue, waitForFileEditor } from './codeMirrorTestUtils.ts'

// I08-A-FE-02：编辑器模式——CodeMirror 6 受控编辑、选区行号上报、dirty 感知的
// touchVersion 重载（不静默覆盖用户编辑，冲突经 onExternalChange 上报）。

const { invoke, highlightCode } = vi.hoisted(() => ({ invoke: vi.fn(), highlightCode: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../../components/chat/codeHighlight', () => ({ highlightCode }))

function readTextResult(content: string) {
  return { relativePath: 'src/a.ts', content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

function renderEditor(props: Record<string, unknown> = {}) {
  return render(
    <FileTabView
      source="ws-a"
      path="src/a.ts"
      context={{ agentId: 'agent-test', source: 'ws-a' }}
      onTruncated={vi.fn()}
      onContentReady={vi.fn()}
      editing={false}
      {...props}
    />,
  )
}

describe('FileTabView 编辑器模式（I08-A-FE-02）', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    highlightCode.mockReset()
    highlightCode.mockResolvedValue(null)
    invoke.mockImplementation((cmd: string, args: { relativePath?: string } | undefined) => {
      if (cmd === 'read_workspace_text') {
        const content = args?.relativePath === 'other.ts' ? 'const other = 9' : 'const x = 1'
        return Promise.resolve(readTextResult(content))
      }
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
  })

  it('editing=true → CodeMirror 承载已加载内容，输入经 onContentChange 上报（不改文件）', async () => {
    const onContentChange = vi.fn()
    renderEditor({ editing: true, onContentChange })
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 2')
    expect(onContentChange).toHaveBeenCalledWith('const x = 2')
    expect(editor.state.doc.toString()).toBe('const x = 2')
    expect(invoke).not.toHaveBeenCalledWith('write_workspace_text', expect.anything())
  })

  it('editing=false → 只读视图（无 CodeMirror）', async () => {
    renderEditor({ editing: false })
    await waitFor(() => expect(document.querySelector('.file-tab-code')).not.toBeNull())
    expect(document.querySelector('.file-code-editor')).toBeNull()
  })

  it('编辑后退出仍重新应用只读语法高亮，并保持同一代码布局契约', async () => {
    highlightCode.mockImplementation(async (_language: string, code: string) => `<span class="pl-k">const</span>${code.slice(5)}`)
    const { rerender } = renderEditor({ editing: false })
    await waitFor(() => expect(document.querySelector('.file-tab-code')).not.toBeNull())
    await waitFor(() => expect(document.querySelector('.file-tab-code')).toHaveAttribute('data-highlighted', 'true'))

    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} editing onContentChange={vi.fn()} />)
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 2')
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} />)

    await waitFor(() => expect(document.querySelector('.file-tab-code')).toHaveAttribute('data-highlighted', 'true'))
    expect(document.querySelector('.file-tab-code')).toHaveAttribute('data-file-code-layout', 'shared')
    expect(document.querySelector('.file-code-editor')).toBeNull()
  })

  it('退出编辑后高亮已完成时，迟到的保存回执不会把高亮清掉', async () => {
    let highlightCalls = 0
    let resolveExitHighlight: ((html: string) => void) | undefined
    highlightCode.mockImplementation(async (_language: string, code: string) => {
      highlightCalls += 1
      if (highlightCalls === 1) return `<span class="pl-k">const</span>${code.slice(5)}`
      if (highlightCalls === 2) return new Promise<string>(resolve => { resolveExitHighlight = resolve })
      return `<span class="pl-k">const</span>${code.slice(5)}`
    })

    const { rerender } = renderEditor({ editing: false })
    await waitFor(() => expect(document.querySelector('.file-tab-code')).toHaveAttribute('data-highlighted', 'true'))

    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} editing onContentChange={vi.fn()} />)
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 2')
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} />)
    await waitFor(() => expect(highlightCalls).toBe(2))

    await act(async () => {
      resolveExitHighlight?.('<span class="pl-k">const</span> x = 2')
    })
    await waitFor(() => expect(document.querySelector('.file-tab-code')).toHaveAttribute('data-highlighted', 'true'))

    rerender(<FileTabView
      source="ws-a"
      path="src/a.ts"
      context={{ agentId: 'agent-test', source: 'ws-a' }}
      onTruncated={vi.fn()}
      saveReceipt={{ version: 1, expectedContent: 'const x = 2', persistedContent: 'const x = 2' }}
    />)
    await waitFor(() => expect(document.querySelector('.file-tab-code')).toHaveAttribute('data-highlighted', 'true'))
  })

  it('CodeMirror 选区 → onSelectionChange 报 1-based 行号区间', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('a\nb\nc\nd'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    const onSelectionChange = vi.fn()
    renderEditor({ editing: true, onSelectionChange })
    const editor = await waitForFileEditor('a\nb\nc\nd')
    act(() => editor.dispatch({ selection: { anchor: 2, head: 6 } }))
    expect(onSelectionChange).toHaveBeenCalledWith({ startLine: 2, endLine: 4 })
  })

  it('编辑中 touchVersion 递增且磁盘 ≠ 编辑内容 → onExternalChange 上报，编辑内容不被覆盖', async () => {
    const onExternalChange = vi.fn()
    const onContentChange = vi.fn()
    const { rerender } = renderEditor({ editing: true, onExternalChange, onContentChange })
    const editor = await waitForFileEditor('const x = 1')
    // 用户编辑
    replaceFileEditorValue(editor, 'const x = 999')
    expect(onContentChange).toHaveBeenCalledWith('const x = 999')
    // agent 工具写入同文件 → touchVersion 递增 → 磁盘变为 'const x = 2'
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={vi.fn()} editing onExternalChange={onExternalChange} onContentChange={onContentChange} />)
    await waitFor(() => expect(onExternalChange).toHaveBeenCalled())
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
  })

  it('编辑中 touchVersion 递增但用户未改 → 内容安全刷新到磁盘', async () => {
    const onExternalChange = vi.fn()
    const onContentReady = vi.fn()
    const { rerender } = renderEditor({ editing: true, onExternalChange, onContentReady })
    await waitForFileEditor('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={onContentReady} editing onExternalChange={onExternalChange} />)
    await waitForFileEditor('const x = 2')
    expect(onExternalChange).not.toHaveBeenCalled()
    expect(onContentReady).toHaveBeenCalledWith('const x = 2')
  })

  it('只读模式 touchVersion 递增 → 保持 W2-09 重拉语义（内容替换 + onContentReady）', async () => {
    const onContentReady = vi.fn()
    const { rerender } = renderEditor({ editing: false, onContentReady })
    await screen.findByText('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={onContentReady} />)
    await waitFor(() => expect(screen.getByText('const x = 2')).toBeTruthy())
    expect(onContentReady).toHaveBeenCalledWith('const x = 2')
  })

  it('退出编辑模式不静默覆盖未保存修改：touchVersion 已定义时退出编辑，磁盘内容不得替换未保存编辑', async () => {
    const onExternalChange = vi.fn()
    const onContentReady = vi.fn()
    const { rerender } = renderEditor({ editing: true, onExternalChange, onContentReady })
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 999')
    // agent 已触碰（touchVersion 定义）；磁盘仍为 'const x = 1'
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    // 退出编辑：旧实现因 editing 在 effect 依赖里重跑 → 300ms 后 loadContent 静默覆盖
    rerender(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} onContentReady={onContentReady} onExternalChange={onExternalChange} />)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(screen.getByText('const x = 999')).toBeTruthy()
    expect(onExternalChange).not.toHaveBeenCalled()
  })

  it('带未保存内容重进编辑模式不误报冲突：touchVersion 已定义且磁盘未变，probeDisk 不触发 onExternalChange', async () => {
    const onExternalChange = vi.fn()
    const { rerender } = renderEditor({ editing: true, onExternalChange })
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 999')
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    // 退出编辑 → 重新进入编辑模式
    rerender(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} onContentReady={vi.fn()} />)
    rerender(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} onContentReady={vi.fn()} editing onExternalChange={onExternalChange} />)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(onExternalChange).not.toHaveBeenCalled()
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
  })

  it('saveAnchorToken 递增 → 重拉磁盘对齐（保存后的磁盘锚点推进）', async () => {
    const onContentReady = vi.fn()
    const { rerender } = renderEditor({ editing: true, onContentReady })
    await waitForFileEditor('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 3'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    rerender(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} onContentReady={onContentReady} editing saveAnchorToken={1} />)
    await waitForFileEditor('const x = 3')
  })
})
