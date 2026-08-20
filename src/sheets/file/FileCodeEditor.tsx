import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { Compartment } from '@codemirror/state'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'

const fileEditorHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: 'var(--syn-kw, #b48ead)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-str, #96b5b4)' },
  { tag: tags.regexp, color: 'var(--syn-re, #d08770)' },
  { tag: tags.comment, color: 'var(--syn-cmt, #8792a2)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-lit, #d08770)' },
  { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--syn-ent, #ebcb8b)' },
  { tag: [tags.variableName, tags.labelName], color: 'var(--syn-var, #c0c5ce)' },
  { tag: tags.propertyName, color: 'var(--syn-prop, #c0c5ce)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-fn, #8fa1b3)' },
  { tag: tags.heading, color: 'var(--syn-mh, #8fa1b3)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--accent)' },
  { tag: tags.invalid, color: 'var(--danger)' },
])

/**
 * File 模块私有的 CodeMirror 6 适配器。
 *
 * Workspace 宿主只接触 value/change/selection，不持有 EditorView；语言包按路径异步
 * 装入，未知扩展名保持纯文本。这样编辑器实现可以替换而不改插件或 Sheet 契约。
 */
export default function FileCodeEditor({ path, value, onChange, onSelectionChange }: {
  path: string
  value: string
  onChange?: (value: string) => void
  onSelectionChange?: (selection: DispatchSelection | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const applyingExternalValue = useRef(false)
  const callbacksRef = useRef({ onChange, onSelectionChange })
  callbacksRef.current = { onChange, onSelectionChange }

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const language = new Compartment()
    let disposed = false

    const view = new EditorView({
      doc: value,
      parent,
      extensions: [
        basicSetup,
        syntaxHighlighting(fileEditorHighlightStyle),
        language.of([]),
        EditorView.contentAttributes.of({ 'aria-label': `编辑 ${path}`, spellcheck: 'false' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !applyingExternalValue.current) {
            callbacksRef.current.onChange?.(update.state.doc.toString())
          }
          if (update.docChanged || update.selectionSet) {
            if (update.state.doc.length === 0) {
              callbacksRef.current.onSelectionChange?.(null)
              return
            }
            const selection = update.state.selection.main
            callbacksRef.current.onSelectionChange?.({
              startLine: update.state.doc.lineAt(selection.from).number,
              endLine: update.state.doc.lineAt(selection.to).number,
            })
          }
        }),
      ],
    })
    viewRef.current = view

    const description = LanguageDescription.matchFilename(languages, path)
    if (description) {
      void description.load().then(support => {
        if (!disposed && viewRef.current === view) {
          view.dispatch({ effects: language.reconfigure(support) })
        }
      }).catch(() => {
        // 未安装/加载失败的语言按 CodeMirror 纯文本模式继续编辑。
      })
    }

    return () => {
      disposed = true
      viewRef.current = null
      view.destroy()
    }
    // FileTabView 以 path 作为 key；单个实例只对应一个文档与语言生命周期。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    applyingExternalValue.current = true
    try {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    } finally {
      applyingExternalValue.current = false
    }
  }, [value])

  return <div ref={hostRef} className="file-code-editor" data-path={path} />
}
