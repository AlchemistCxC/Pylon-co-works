import { act, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'

export function fileEditorView(): EditorView {
  const editor = document.querySelector<HTMLElement>('.file-code-editor .cm-editor')
  if (!editor) throw new Error('CodeMirror editor not mounted')
  const view = EditorView.findFromDOM(editor)
  if (!view) throw new Error('CodeMirror EditorView not found')
  return view
}

export async function waitForFileEditor(expectedValue?: string): Promise<EditorView> {
  return waitFor(() => {
    const view = fileEditorView()
    if (expectedValue !== undefined && view.state.doc.toString() !== expectedValue) {
      throw new Error(`Editor value has not settled: ${view.state.doc.toString()}`)
    }
    return view
  })
}

export function replaceFileEditorValue(view: EditorView, value: string): void {
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  })
}
