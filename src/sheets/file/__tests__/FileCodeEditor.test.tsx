// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import FileCodeEditor from '../FileCodeEditor'

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
})
