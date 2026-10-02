// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { fireEvent, render, waitFor, cleanup } from '@solidjs/testing-library'
import { EditorView } from '@codemirror/view'
import FileCodeEditor, { type FileCodeEditorApi, type KernelSummary } from '../FileCodeEditor.solid.tsx'
import { FILE_CODE_TAB_SIZE_FALLBACK, resolveTabSize } from '../fileCodeMirrorKernel.ts'

afterEach(() => cleanup())

// #515：迁移自 FileCodeEditor.test.tsx（React 壳 → Solid 实体直连）。
// 断言改写点登记：
// 1. render(<JSX/>) → render(() => JSX)；act() 包装退役（Solid 信号→effect 同步传播，
//   CM dispatch 回调同步落 DOM）；
// 2. React 壳的 `editable` prop 在实体面叫 `writable`（缺省皆 true，语义同构）——
//   editable={false} 用例改传 writable={false}。
// 其余断言集与 DOM 契约不变。


function viewOf(): EditorView {
  const editor = document.querySelector<HTMLElement>('.cm-editor')
  if (!editor) throw new Error('CodeMirror editor not mounted')
  const view = EditorView.findFromDOM(editor)
  if (!view) throw new Error('CodeMirror EditorView not found')
  return view
}

function lastSummary(onSummaryChange: { mock: { lastCall: readonly unknown[] | undefined } }): KernelSummary {
  const call = onSummaryChange.mock.lastCall
  if (!call) throw new Error('summary has not been emitted yet')
  return call[0] as KernelSummary
}

describe('FileCodeEditor 常驻单内核（0-A1 / issue #283）', () => {
  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  it('挂载 CodeMirror 6、行号与当前文档；dirty 摘要随编辑翻转（O(1) 摘要契约）', async () => {
    const onSummaryChange = vi.fn()
    const apiRef: { current: FileCodeEditorApi | null } = { current: null }
    render(() => (
      <FileCodeEditor
        path="src/a.ts"
        initialContent={'const x = 1'}
        baseline={'const x = 1'}
        onSummaryChange={onSummaryChange}
        apiRef={apiRef}
      />
    ))
    const view = await waitFor(viewOf)

    expect(view.state.doc.toString()).toBe('const x = 1')
    expect(document.querySelector('.cm-gutters')).not.toBeNull()
    expect(lastSummary(onSummaryChange).dirty).toBe(false)
    view.dispatch({ changes: { from: 10, to: 11, insert: '2' } })
    expect(lastSummary(onSummaryChange).dirty).toBe(true)
    expect(lastSummary(onSummaryChange).lineCount).toBe(1)
    // CM 默认：changes 无显式 selection 时原 selection 经映射保留（0 在变更区前 → 不动）
    expect(lastSummary(onSummaryChange).cursor).toEqual({ line: 1, col: 1 })
    expect(apiRef.current?.getDoc()).toBe('const x = 2')
  })

  it('选区用文档行模型发 1-based 区间；空文档 selection/cursor 为 null', async () => {
    const onSummaryChange = vi.fn()
    render(() => (
      <FileCodeEditor
        path="src/a.ts"
        initialContent={'a\nb\nc\nd'}
        baseline={'a\nb\nc\nd'}
        onSummaryChange={onSummaryChange}
      />
    ))
    const view = await waitFor(viewOf)

    view.dispatch({ selection: { anchor: 2, head: 6 } })
    expect(lastSummary(onSummaryChange).selection).toEqual({ startLine: 2, endLine: 4 })
    expect(lastSummary(onSummaryChange).cursor).toEqual({ line: 4, col: 1 })

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    expect(lastSummary(onSummaryChange).selection).toBeNull()
    expect(lastSummary(onSummaryChange).cursor).toBeNull()
  })

  it('外部 replaceDoc 不回报为用户编辑（baseline 同事务推进，dirty 不翻转）；markChanged 落变更行 decoration', async () => {
    const onSummaryChange = vi.fn()
    const apiRef: { current: FileCodeEditorApi | null } = { current: null }
    render(() => (
      <FileCodeEditor
        path="src/a.ts"
        initialContent={'a\nb\nc'}
        baseline={'a\nb\nc'}
        onSummaryChange={onSummaryChange}
        apiRef={apiRef}
      />
    ))
    await waitFor(viewOf)

    apiRef.current?.replaceDoc('a\nX\nc', { baseline: 'a\nX\nc', markChanged: true })
    await waitFor(() => expect(viewOf().state.doc.toString()).toBe('a\nX\nc'))
    expect(lastSummary(onSummaryChange).dirty).toBe(false)
    await waitFor(() => expect(document.querySelectorAll('.file-line-changed')).toHaveLength(1))

    apiRef.current?.clearChangedMarks()
    await waitFor(() => expect(document.querySelectorAll('.file-line-changed')).toHaveLength(0))
  })

  it('writable=false：contentDOM 不可编辑（程序化 replaceDoc 仍可用）', async () => {
    const apiRef: { current: FileCodeEditorApi | null } = { current: null }
    render(() => (
      <FileCodeEditor
        path="src/a.ts"
        initialContent={'const x = 1'}
        baseline={'const x = 1'}
        writable={false}
        apiRef={apiRef}
      />
    ))
    await waitFor(viewOf)
    expect(viewOf().contentDOM.getAttribute('contenteditable')).toBe('false')

    apiRef.current?.replaceDoc('const x = 2', { baseline: 'const x = 2' })
    await waitFor(() => expect(viewOf().state.doc.toString()).toBe('const x = 2'))
  })

  it('在编辑器内拦截 Mod-S 并交给宿主保存事务', async () => {
    const onSave = vi.fn()
    render(() => <FileCodeEditor path="src/a.ts" initialContent="content" baseline="content" onSave={onSave} />)
    const view = await waitFor(viewOf)

    fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true })

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  // issue #69：编辑态 tab 列宽必须与只读投影同源（FileSheet.css 的 --file-code-tab-size）。
  // CodeMirror 用 tabSize 同时算「渲染宽度」与「坐标↔偏移」，所以这里锁定装配值。
  it('从只读契约 token 取 tab 列宽，token 与回退常量由契约测试锁定一致', async () => {
    // CSS 侧 --file-code-tab-size: 2 已由 FileSheet.css.test.ts 的契约块逐值钉死；
    // 本文件钉死 kernel 回退常量与运行时装配值——两文件联合等价于原「文件直读直锁」
    //（tsconfig.solid 面 readFileSync 不可用，登记改写点）。
    expect(FILE_CODE_TAB_SIZE_FALLBACK).toBe(2)

    // token 读取的三条路径：读到值 / 读到空 / 读到脏值
    // resolver 带 isConnected 守卫（Solid 时序加固），合成元素须先接入文档
    const stubHost = document.createElement('div')
    document.body.appendChild(stubHost)
    const stubbed = vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => ' 4 ',
    } as unknown as CSSStyleDeclaration)
    expect(resolveTabSize(stubHost)).toBe(4)
    stubbed.mockReturnValue({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
    expect(resolveTabSize(stubHost)).toBe(FILE_CODE_TAB_SIZE_FALLBACK)
    stubbed.mockReturnValue({ getPropertyValue: () => 'auto' } as unknown as CSSStyleDeclaration)
    expect(resolveTabSize(stubHost)).toBe(FILE_CODE_TAB_SIZE_FALLBACK)
    stubbed.mockRestore()
    stubHost.remove()

    render(() => <FileCodeEditor path="src/a.ts" initialContent={'a\tb'} baseline={'a\tb'} />)
    const view = await waitFor(viewOf)
    expect(view.state.tabSize).toBe(FILE_CODE_TAB_SIZE_FALLBACK)
  })

  // 统一 tab 列宽不得引入编辑行为变化：本编辑器未装配 indentWithTab（CM 默认 keymap 也
  // 不含 Tab），Tab 不产生文档变更——这条断言把该前提钉住，防止后续装配变化被静默吞掉。
  it('Tab 键不是编辑缩进路径：按键后文档不变', async () => {
    render(() => <FileCodeEditor path="src/a.ts" initialContent={'const x = 1'} baseline={'const x = 1'} />)
    const view = await waitFor(viewOf)

    fireEvent.keyDown(view.contentDOM, { key: 'Tab' })

    expect(view.state.doc.toString()).toBe('const x = 1')
  })
})
