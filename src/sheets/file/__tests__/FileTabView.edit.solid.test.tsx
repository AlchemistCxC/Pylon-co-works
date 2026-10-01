// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import FileTabView, { type FileTabViewProps } from '../FileTabView.solid.tsx'
import type { FileCodeEditorApi, KernelSummary } from '../fileCodeMirrorKernel.ts'
import { useWorkspaceStore, touchedFileVersionKey } from '../../../domains/workspace/workspaceStore'
import { resetStores } from '../../../test/resetStores'
import { fileEditorEditable, fileEditorView, replaceFileEditorValue, waitForFileEditor } from './codeMirrorTestUtils.solid.ts'

afterEach(() => cleanup())

// I08-A-FE-02 / 0-A1：常驻单内核的编辑语义——KernelSummary 摘要上报、dirty 感知的
// touchVersion 重载（不静默覆盖用户编辑，冲突经 onExternalChange 上报）、外部刷新
// 落变更行 decoration、saveAnchorToken 锚点推进。
//
// #515：迁移自 FileTabView.edit.test.tsx（React 桥 + rerender → Solid 实体直连 + 信号）。
// 断言改写点登记：
// 1. render(<JSX/>) → render(() => JSX)；rerender(nextProps) → 信号驱动
//  （setPropsSignal 合并覆盖，等价 React 父组件重渲染）；
// 2. act() 包装退役（Solid 信号→effect 同步传播；deferred/计时路径用微任务与
//  advanceTimersByTimeAsync 对齐）；
// 3. replaceFileEditorValue 改用 codeMirrorTestUtils.solid（无 React act 包装）。
// 其余断言集与 DOM 契约不变。直连实体同时绕开 React 桥 bridgedProps/reconcile 对
// apiRef 类可变引用对象的克隆覆盖（Solid 子树对 store 克隆内字段的变异会被下一次
// reconcile 用 React 侧原始对象抹平）——生产链路（FileViewHost.solid → 本实体）为
// solid 直连，不受此桥面语义影响。

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

function readTextResult(content: string) {
  return { relativePath: 'src/a.ts', content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

interface EditorHarness {
  apiRef: { current: FileCodeEditorApi | null }
  summaries: KernelSummary[]
  setProps: (next: Partial<FileTabViewProps>) => void
}

function renderEditor(props: Partial<FileTabViewProps> = {}): EditorHarness {
  const apiRef: { current: FileCodeEditorApi | null } = { current: null }
  const summaries: KernelSummary[] = []
  const onSummaryChange = (summary: KernelSummary) => { summaries.push(summary) }
  const [propsSignal, setPropsSignal] = createSignal<Partial<FileTabViewProps>>(props)
  render(() => (
    <FileTabView
      source="ws-a"
      path="src/a.ts"
      context={{ agentId: 'agent-test', source: 'ws-a' }}
      onTruncated={vi.fn()}
      onContentReady={propsSignal().onContentReady}
      onSummaryChange={onSummaryChange}
      apiRef={apiRef}
      writable={propsSignal().writable}
      onExternalChange={propsSignal().onExternalChange}
      saveAnchorToken={propsSignal().saveAnchorToken}
      saveReceipt={propsSignal().saveReceipt}
    />
  ))
  return {
    apiRef,
    summaries,
    setProps: next => setPropsSignal(previous => ({ ...previous, ...next })),
  }
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

  it('writable=false（物理例外）→ 内核只读档；翻转（同一实例不重挂）', async () => {
    const harness = renderEditor({ writable: false })
    await waitForFileEditor('const x = 1')
    expect(fileEditorEditable()).toBe(false)

    harness.setProps({ writable: true })
    await waitFor(() => expect(fileEditorEditable()).toBe(true))
  })

  it('CodeMirror 选区 → KernelSummary 报 1-based 行号区间', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('a\nb\nc\nd'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    const { summaries } = renderEditor()
    const editor = await waitForFileEditor('a\nb\nc\nd')
    editor.dispatch({ selection: { anchor: 2, head: 6 } })
    expect(lastSummary(summaries).selection).toEqual({ startLine: 2, endLine: 4 })
  })

  it('编辑中 touchVersion 递增且磁盘 ≠ 编辑内容 → onExternalChange 上报，编辑内容不被覆盖', async () => {
    const onExternalChange = vi.fn()
    const harness = renderEditor({ onExternalChange })
    const editor = await waitForFileEditor('const x = 1')
    // 用户编辑
    replaceFileEditorValue(editor, 'const x = 999')
    expect(lastSummary(harness.summaries).dirty).toBe(true)
    // agent 工具写入同文件 → touchVersion 递增 → 磁盘变为 'const x = 2'
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    await waitFor(() => expect(onExternalChange).toHaveBeenCalled())
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
  })

  it('编辑中 touchVersion 递增但用户未改 → 内容安全刷新到磁盘', async () => {
    const onExternalChange = vi.fn()
    const onContentReady = vi.fn()
    renderEditor({ onExternalChange, onContentReady })
    await waitForFileEditor('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    await waitForFileEditor('const x = 2')
    expect(onExternalChange).not.toHaveBeenCalled()
    expect(onContentReady).toHaveBeenCalledWith('const x = 2')
  })

  it('writable=false（只读档）touchVersion 递增 → 重拉语义保留（文档替换 + 变更行 decoration + onContentReady）', async () => {
    const onContentReady = vi.fn()
    renderEditor({ writable: false, onContentReady })
    await waitForFileEditor('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    await waitForFileEditor('const x = 2')
    expect(onContentReady).toHaveBeenCalledWith('const x = 2')
    await waitFor(() => expect(document.querySelectorAll('.file-line-changed')).toHaveLength(1))
  })

  it('脏缓冲下 touchVersion 重载不静默覆盖未保存修改（磁盘未变 → 不误报、不替换）', async () => {
    const onExternalChange = vi.fn()
    renderEditor({ onExternalChange })
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 999')
    // agent 已触碰（touchVersion 定义）；磁盘仍为 'const x = 1'
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    // 退出编辑：真实 400ms 等待语义 → fake timers 推进（gatewaySheetView.ui 先例），
    // 断言强度不变——仍须越过 300ms debounce 窗口后验证未保存编辑未被覆盖。
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(400)
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
    expect(onExternalChange).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('带未保存内容时 touchVersion 已定义且磁盘未变，probeDisk 不触发 onExternalChange', async () => {
    const onExternalChange = vi.fn()
    const harness = renderEditor({ onExternalChange })
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 999')
    useWorkspaceStore.setState({ touchVersions: { [touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')]: 7 } })
    await waitFor(() => expect(harness.apiRef.current).not.toBeNull())
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(400)
    expect(onExternalChange).not.toHaveBeenCalled()
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
    vi.useRealTimers()
  })

  it('saveAnchorToken 递增 → 重拉磁盘对齐（保存后的磁盘锚点推进）', async () => {
    const onContentReady = vi.fn()
    const harness = renderEditor({ onContentReady })
    await waitForFileEditor('const x = 1')
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 3'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    harness.setProps({ saveAnchorToken: 1 })
    await waitForFileEditor('const x = 3')
  })

  it('保存回执：无更新编辑 → 锚点推进 + 变更标记清空；有更新编辑 → 保留编辑只推进锚点', async () => {
    const harness = renderEditor()
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 2')
    expect(lastSummary(harness.summaries).dirty).toBe(true)

    harness.setProps({ saveReceipt: { version: 1, expectedContent: 'const x = 2', persistedContent: 'const x = 2' } })
    await waitFor(() => expect(lastSummary(harness.summaries).dirty).toBe(false))
    expect(fileEditorView().state.doc.toString()).toBe('const x = 2')

    // 保存进行中继续输入 → 回执只推进锚点，不覆盖后续编辑（dirty 保持 true）
    replaceFileEditorValue(fileEditorView(), 'const x = 3')
    harness.setProps({ saveReceipt: { version: 2, expectedContent: 'const x = 2', persistedContent: 'const x = 2' } })
    await Promise.resolve()
    expect(fileEditorView().state.doc.toString()).toBe('const x = 3')
    expect(lastSummary(harness.summaries).dirty).toBe(true)
  })
})
