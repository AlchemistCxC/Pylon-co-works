// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import FileTabView, { type FileCodeEditorApi, type KernelSummary } from '../FileTabView'
import { useWorkspaceStore, touchedFileVersionKey } from '../../../domains/workspace/workspaceStore'
import { resetStores } from '../../../test/resetStores'
import { fileEditorEditable, fileEditorView, replaceFileEditorValue, waitForFileEditor } from './codeMirrorTestUtils.ts'

// I08-A-FE-02 / 0-A1：常驻单内核的编辑语义——KernelSummary 摘要上报、dirty 感知的
// touchVersion 重载（不静默覆盖用户编辑，冲突经 onExternalChange 上报）、外部刷新
// 落变更行 decoration、saveAnchorToken 锚点推进。

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

function readTextResult(content: string) {
  return { relativePath: 'src/a.ts', content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

function renderEditor(props: Record<string, unknown> = {}) {
  const apiRef: { current: FileCodeEditorApi | null } = { current: null }
  const summaries: KernelSummary[] = []
  const onSummaryChange = (summary: KernelSummary) => { summaries.push(summary) }
  const utils = render(
    <FileTabView
      source="ws-a"
      path="src/a.ts"
      context={{ agentId: 'agent-test', source: 'ws-a' }}
      onTruncated={vi.fn()}
      onContentReady={vi.fn()}
      onSummaryChange={onSummaryChange}
      apiRef={apiRef}
      {...props}
    />,
  )
  return { apiRef, summaries, onSummaryChange, ...utils }
}

function lastSummary(summaries: KernelSummary[]): KernelSummary {
  const summary = summaries[summaries.length - 1]
  if (!summary) throw new Error('summary has not been emitted yet')
  return summary
}

describe('FileTabView 编辑器模式（0-A1 单内核）', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    invoke.mockImplementation((cmd: string, args: { relativePath?: string } | undefined) => {
      if (cmd === 'read_workspace_text') {
        const content = args?.relativePath === 'other.ts' ? 'const other = 9' : 'const x = 1'
        return Promise.resolve(readTextResult(content))
      }
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
  })

  it('默认可写（writable 缺省 true）→ 内核可编辑，输入使摘要 dirty 翻转（不改文件）', async () => {
    const { summaries } = renderEditor()
    const editor = await waitForFileEditor('const x = 1')
    expect(fileEditorEditable()).toBe(true)
    replaceFileEditorValue(editor, 'const x = 2')
    expect(lastSummary(summaries).dirty).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('write_workspace_text', expect.anything())
  })

  it('writable=false（物理例外）→ 内核只读档；rerender 翻转（同一实例不重挂）', async () => {
    const { onSummaryChange, apiRef, rerender } = renderEditor({ writable: false })
    await waitForFileEditor('const x = 1')
    expect(fileEditorEditable()).toBe(false)

    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={vi.fn()} onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await waitFor(() => expect(fileEditorEditable()).toBe(true))
  })

  it('CodeMirror 选区 → KernelSummary 报 1-based 行号区间', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('a\nb\nc\nd'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    const { summaries } = renderEditor()
    const editor = await waitForFileEditor('a\nb\nc\nd')
    act(() => editor.dispatch({ selection: { anchor: 2, head: 6 } }))
    expect(lastSummary(summaries).selection).toEqual({ startLine: 2, endLine: 4 })
  })

  it('编辑中 touchVersion 递增且磁盘 ≠ 编辑内容 → onExternalChange 上报，编辑内容不被覆盖', async () => {
    const onExternalChange = vi.fn()
    const { apiRef, onSummaryChange, rerender, summaries } = renderEditor({ onExternalChange })
    const editor = await waitForFileEditor('const x = 1')
    // 用户编辑
    replaceFileEditorValue(editor, 'const x = 999')
    expect(lastSummary(summaries).dirty).toBe(true)
    // agent 工具写入同文件 → touchVersion 递增 → 磁盘变为 'const x = 2'
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={vi.fn()} onExternalChange={onExternalChange} onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await waitFor(() => expect(onExternalChange).toHaveBeenCalled())
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
  })

  it('编辑中 touchVersion 递增但用户未改 → 内容安全刷新到磁盘', async () => {
    const onExternalChange = vi.fn()
    const onContentReady = vi.fn()
    const { onSummaryChange, apiRef, rerender } = renderEditor({ onExternalChange, onContentReady })
    await waitForFileEditor('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={onContentReady} onExternalChange={onExternalChange}  onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await waitForFileEditor('const x = 2')
    expect(onExternalChange).not.toHaveBeenCalled()
    expect(onContentReady).toHaveBeenCalledWith('const x = 2')
  })

  it('writable=false（只读档）touchVersion 递增 → 重拉语义保留（文档替换 + 变更行 decoration + onContentReady）', async () => {
    const onContentReady = vi.fn()
    const { onSummaryChange, apiRef, rerender } = renderEditor({ writable: false, onContentReady })
    await waitForFileEditor('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={onContentReady} writable={false} onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await waitForFileEditor('const x = 2')
    expect(onContentReady).toHaveBeenCalledWith('const x = 2')
    await waitFor(() => expect(document.querySelectorAll('.file-line-changed')).toHaveLength(1))
  })

  it('脏缓冲下 touchVersion 重载不静默覆盖未保存修改（磁盘未变 → 不误报、不替换）', async () => {
    const onExternalChange = vi.fn()
    const { onSummaryChange, apiRef, rerender } = renderEditor({ onExternalChange })
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 999')
    // agent 已触碰（touchVersion 定义）；磁盘仍为 'const x = 1'
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    // 退出编辑：真实 400ms 等待 → fake timers 推进（gatewaySheetView.ui 先例），
    // 断言强度不变——仍须越过 300ms debounce 窗口后验证未保存编辑未被覆盖。
    vi.useFakeTimers()
    rerender(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} onContentReady={vi.fn()} onExternalChange={onExternalChange} onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
    expect(onExternalChange).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('带未保存内容时 touchVersion 已定义且磁盘未变，probeDisk 不触发 onExternalChange', async () => {
    const onExternalChange = vi.fn()
    const { onSummaryChange, apiRef, rerender } = renderEditor({ onExternalChange })
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 999')
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    // 退出编辑 → 重新进入编辑模式。
    vi.useFakeTimers()
    rerender(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} onContentReady={vi.fn()}  onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    rerender(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} onContentReady={vi.fn()} onExternalChange={onExternalChange} onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(onExternalChange).not.toHaveBeenCalled()
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
    vi.useRealTimers()
  })

  it('saveAnchorToken 递增 → 重拉磁盘对齐（保存后的磁盘锚点推进）', async () => {
    const onContentReady = vi.fn()
    const { onSummaryChange, apiRef, rerender } = renderEditor({ onContentReady })
    await waitForFileEditor('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 3'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    rerender(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} onContentReady={onContentReady} saveAnchorToken={1} onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await waitForFileEditor('const x = 3')
  })

  it('保存回执：无更新编辑 → 锚点推进 + 变更标记清空；有更新编辑 → 保留编辑只推进锚点', async () => {
    const { apiRef, onSummaryChange, rerender, summaries } = renderEditor()
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 2')
    expect(lastSummary(summaries).dirty).toBe(true)

    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={vi.fn()} saveReceipt={{ version: 1, expectedContent: 'const x = 2', persistedContent: 'const x = 2' }}  onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await waitFor(() => expect(lastSummary(summaries).dirty).toBe(false))
    expect(fileEditorView().state.doc.toString()).toBe('const x = 2')

    // 保存进行中继续输入 → 回执只推进锚点，不覆盖后续编辑（dirty 保持 true）
    replaceFileEditorValue(fileEditorView(), 'const x = 3')
    rerender(<FileTabView source="ws-a" path="src/a.ts" context={{ agentId: 'agent-test', source: 'ws-a' }} onTruncated={vi.fn()} onContentReady={vi.fn()} saveReceipt={{ version: 2, expectedContent: 'const x = 2', persistedContent: 'const x = 2' }}  onSummaryChange={onSummaryChange} apiRef={apiRef} />)
    await act(async () => {})
    expect(fileEditorView().state.doc.toString()).toBe('const x = 3')
    expect(lastSummary(summaries).dirty).toBe(true)
  })
})
