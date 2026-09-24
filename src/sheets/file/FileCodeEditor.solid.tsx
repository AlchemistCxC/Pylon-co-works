import { createEffect, onCleanup, onMount, untrack } from 'solid-js'
import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { resolveFileLanguageProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchResolver.ts'

/**
 * 两态几何契约（FileSheet.css 的 `--file-code-tab-size`）在编辑侧的镜像值。
 *
 * 只读投影用 CSS 消费该 token；CodeMirror 则必须把同一个值写进 `EditorState.tabSize`：
 * CM 用 tabSize 同时计算「tab 字符的渲染宽度」与「坐标 ↔ 偏移」换算，只靠 CSS 覆盖
 * （`.cm-line { tab-size }`）会让含 tab 的行上点击/选区落点偏移。构造时从宿主元素的
 * 计算样式读 token（jsdom 里读不到时回退此常量，其值由契约测试锁定与 CSS 一致）。
 */
export const FILE_CODE_TAB_SIZE_FALLBACK = 2

/** 读契约 token（导出供契约测试覆盖“读到值 / 读到空 / 读到脏值”三条路径）。 */
export function resolveTabSize(host: HTMLElement | null): number {
  // isConnected 守卫 + try/catch：Solid 的 ref/onMount 时序里元素可能尚未连接（React
  // ref 在 commit 后触发、无此窗口），jsdom 对未连接/特殊树形的宿主取计算样式会直接
  // 抛错——token 是渐进增强，回退常量由契约测试锁定与 CSS 一致。
  if (!host || !host.isConnected || typeof getComputedStyle !== 'function') return FILE_CODE_TAB_SIZE_FALLBACK
  try {
    const raw = getComputedStyle(host).getPropertyValue('--file-code-tab-size').trim()
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : FILE_CODE_TAB_SIZE_FALLBACK
  } catch {
    return FILE_CODE_TAB_SIZE_FALLBACK
  }
}

// Language metadata is sizeable (it enumerates every CodeMirror language) and
// is only needed once an editor is opened.  Keep it out of the initial shell
// chunk while preserving the existing filename-based language selection.
let languageDataPromise: Promise<readonly LanguageDescription[]> | null = null
function loadLanguageData(): Promise<readonly LanguageDescription[]> {
  if (!languageDataPromise) {
    languageDataPromise = import('@codemirror/language-data').then(({ languages }) => languages)
  }
  return languageDataPromise
}

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
 * File 模块私有的 CodeMirror 6 适配器（Solid 实体，#279 第 2 梯队；与 React 版逐行同构）。
 *
 * Workspace 宿主只接触 value/change/selection，不持有 EditorView；语言包按路径异步
 * 装入，未知扩展名保持纯文本。这样编辑器实现可以替换而不改插件或 Sheet 契约。
 * 宿主以「每文档一实例」的方式挂载（FileTabView 的 keyed Show 按 targetKey:path 重建），
 * 单实例只对应一个文档与语言生命周期。
 */
export default function FileCodeEditor(props: {
  path: string
  value: string
  revealLine?: number
  onChange?: (value: string) => void
  onSelectionChange?: (selection: DispatchSelection | null) => void
  onSave?: () => void
}) {
  let hostElement: HTMLDivElement | undefined
  let view: EditorView | null = null
  let applyingExternalValue = false

  onMount(() => {
    const parent = hostElement
    if (!parent) return
    const initialValue = untrack(() => props.value)
    const initialPath = untrack(() => props.path)
    const language = new Compartment()
    const languageAbort = new AbortController()
    let disposed = false
    // issue #69：编辑态 tab 列宽与只读投影同源（读契约 token，见 resolveTabSize）。
    const tabSize = resolveTabSize(parent)

    const editor = new EditorView({
      doc: initialValue,
      parent,
      extensions: [
        basicSetup,
        EditorState.tabSize.of(tabSize),
        keymap.of([{
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            props.onSave?.()
            return true
          },
        }]),
        syntaxHighlighting(fileEditorHighlightStyle),
        language.of([]),
        EditorView.contentAttributes.of({ 'aria-label': `编辑 ${initialPath}`, spellcheck: 'false' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !applyingExternalValue) {
            props.onChange?.(update.state.doc.toString())
          }
          if (update.docChanged || update.selectionSet) {
            if (update.state.doc.length === 0) {
              props.onSelectionChange?.(null)
              return
            }
            const selection = update.state.selection.main
            props.onSelectionChange?.({
              startLine: update.state.doc.lineAt(selection.from).number,
              endLine: update.state.doc.lineAt(selection.to).number,
            })
          }
        }),
      ],
    })
    view = editor

    const loadLanguage = async () => {
      const provider = resolveFileLanguageProvider(initialPath)
      if (provider) {
        try {
          const support = await provider.load(initialPath, languageAbort.signal)
          if (support && !disposed && view === editor) {
            editor.dispatch({ effects: language.reconfigure(support) })
            return
          }
        } catch {
          // Provider failure/abort falls through to the built-in language data.
        }
      }
      const languages = await loadLanguageData()
      if (disposed || view !== editor || languageAbort.signal.aborted) return
      const description = LanguageDescription.matchFilename(languages, initialPath)
      if (!description) return
      const support = await description.load()
      if (!disposed && view === editor && !languageAbort.signal.aborted) {
        editor.dispatch({ effects: language.reconfigure(support) })
      }
    }
    void loadLanguage().catch(() => {
      // 未安装/加载失败的语言按 CodeMirror 纯文本模式继续编辑。
    })

    onCleanup(() => {
      disposed = true
      languageAbort.abort()
      view = null
      editor.destroy()
    })
  })

  // 外部值同步：磁盘重拉/保存回执推进。编辑器自身输入回写的值与信号相等即短路，
  // 不会形成回环（与 React 版 [value] effect 同语义）。
  createEffect(() => {
    const editor = view
    const next = props.value
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current === next) return
    applyingExternalValue = true
    try {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: next } })
    } finally {
      applyingExternalValue = false
    }
  })

  createEffect(() => {
    const reveal = props.revealLine
    const editor = view
    if (!editor || !reveal || reveal > editor.state.doc.lines) return
    const line = editor.state.doc.line(reveal)
    editor.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
  })

  return (
    <div
      ref={element => { hostElement = element }}
      class="file-code-editor"
      data-file-code-layout="shared"
      data-path={props.path}
    />
  )
}
