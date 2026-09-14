// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import FileCodeEditor, { FILE_CODE_TAB_SIZE_FALLBACK, resolveTabSize } from '../FileCodeEditor'

const FILE_SHEET_CSS = 'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css'

function viewOf(): EditorView {
  const editor = document.querySelector<HTMLElement>('.cm-editor')
  if (!editor) throw new Error('CodeMirror editor not mounted')
  const view = EditorView.findFromDOM(editor)
  if (!view) throw new Error('CodeMirror EditorView not found')
  return view
}

describe('FileCodeEditor', () => {
  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  it('挂载 CodeMirror 6、行号与当前文档，并把编辑变化上报给宿主', async () => {
    const onChange = vi.fn()
    render(<FileCodeEditor path="src/a.ts" value={'const x = 1\n'} onChange={onChange} />)
    const view = await waitFor(() => viewOf())

    expect(view.state.doc.toString()).toBe('const x = 1\n')
    expect(document.querySelector('.cm-gutters')).not.toBeNull()
    view.dispatch({ changes: { from: 10, to: 11, insert: '2' } })
    expect(onChange).toHaveBeenLastCalledWith('const x = 2\n')
  })

  it('选区使用 CodeMirror 文档行模型上报 1-based 行号，外部 value 更新不回报为用户编辑', async () => {
    const onChange = vi.fn()
    const onSelectionChange = vi.fn()
    const { rerender } = render(<FileCodeEditor path="src/a.ts" value={'a\nb\nc\nd'} onChange={onChange} onSelectionChange={onSelectionChange} />)
    const view = await waitFor(() => viewOf())

    view.dispatch({ selection: { anchor: 2, head: 6 } })
    expect(onSelectionChange).toHaveBeenLastCalledWith({ startLine: 2, endLine: 4 })

    rerender(<FileCodeEditor path="src/a.ts" value={'external\ncontent'} onChange={onChange} onSelectionChange={onSelectionChange} />)
    await waitFor(() => expect(view.state.doc.toString()).toBe('external\ncontent'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('在编辑器内拦截 Mod-S 并交给宿主保存事务', async () => {
    const onSave = vi.fn()
    render(<FileCodeEditor path="src/a.ts" value="content" onSave={onSave} />)
    const view = await waitFor(() => viewOf())

    fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true })

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  // issue #69：编辑态 tab 列宽必须与只读投影同源（FileSheet.css 的 --file-code-tab-size）。
  // CodeMirror 用 tabSize 同时算「渲染宽度」与「坐标↔偏移」，所以这里锁定装配值。
  it('从只读契约 token 取 tab 列宽，token 与回退常量由契约测试锁定一致', async () => {
    const css = readFileSync(FILE_SHEET_CSS, 'utf8')
    const tokenValue = css.match(/--file-code-tab-size:\s*([^;]+);/)?.[1]?.trim()
    expect(tokenValue).toBeTruthy()
    expect(Number.parseFloat(tokenValue!)).toBe(FILE_CODE_TAB_SIZE_FALLBACK)

    // token 读取的三条路径：读到值 / 读到空 / 读到脏值
    const stubHost = document.createElement('div')
    const stubbed = vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => ' 4 ',
    } as unknown as CSSStyleDeclaration)
    expect(resolveTabSize(stubHost)).toBe(4)
    stubbed.mockReturnValue({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
    expect(resolveTabSize(stubHost)).toBe(FILE_CODE_TAB_SIZE_FALLBACK)
    stubbed.mockReturnValue({ getPropertyValue: () => 'auto' } as unknown as CSSStyleDeclaration)
    expect(resolveTabSize(stubHost)).toBe(FILE_CODE_TAB_SIZE_FALLBACK)
    stubbed.mockRestore()

    render(<FileCodeEditor path="src/a.ts" value={'a\tb'} />)
    const view = await waitFor(() => viewOf())
    expect(view.state.tabSize).toBe(FILE_CODE_TAB_SIZE_FALLBACK)
  })

  // 统一 tab 列宽不得引入编辑行为变化：本编辑器未装配 indentWithTab（CM 默认 keymap 也
  // 不含 Tab），Tab 不产生文档变更——这条断言把该前提钉住，防止后续装配变化被静默吞掉。
  it('Tab 键不是编辑缩进路径：按键后文档不变', async () => {
    render(<FileCodeEditor path="src/a.ts" value={'a\tb\nc'} />)
    const view = await waitFor(() => viewOf())

    fireEvent.keyDown(view.contentDOM, { key: 'Tab' })

    expect(view.state.doc.toString()).toBe('a\tb\nc')
  })
})
