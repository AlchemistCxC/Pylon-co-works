import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, Text } from '@codemirror/state'
import { Decoration, keymap, type DecorationSet } from '@codemirror/view'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { changedLineNumbers } from '../../domains/fileDispatch/fileDiff.ts'
import { resolveFileLanguageProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchResolver.ts'

/**
 * fileCodeMirrorKernel — 框架无关的 FileSheet CodeMirror 6 单内核（0-A1，#283；
 * 合并 #279 后抽为共享工厂，React 适配器 FileCodeEditor.tsx 与 Solid 适配器
 * FileCodeEditor.solid.tsx 共同消费——双渲染器同构纪律下的单一行为事实）。
 *
 * 只读与编辑是同一个 EditorView 的 editable compartment 两档；changedLines 是
 * Decoration（StateField 随事务 map 增量维护）；脏检查走 doc.eq(baselineDoc) 结构
 * 共享比较。宿主只接触 KernelSummary 摘要与 FileCodeEditorApi 句柄，不持有内容全文。
 * 生命周期归宿主：create →（setEditable/setBaseline/reveal/api.*）→ destroy。
 */

export const FILE_CODE_TAB_SIZE_FALLBACK = 2

/**
 * 读契约 token（`--file-code-tab-size`，与 FileSheet.css 契约块互为镜像）。
 * isConnected 守卫 + try/catch：Solid 的 ref/onMount 时序里元素可能尚未连接（React
 * ref 在 commit 后触发、无此窗口），jsdom 对未连接/特殊树形的宿主取计算样式会直接
 * 抛错——token 是渐进增强，回退常量由契约测试锁定与 CSS 一致。
 */
export function resolveTabSize(host: HTMLElement | null): number {
  if (!host || !host.isConnected || typeof getComputedStyle !== 'function') return FILE_CODE_TAB_SIZE_FALLBACK
  try {
    const raw = getComputedStyle(host).getPropertyValue('--file-code-tab-size').trim()
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : FILE_CODE_TAB_SIZE_FALLBACK
  } catch {
    return FILE_CODE_TAB_SIZE_FALLBACK
  }
}

/** 键击路径只发这份 O(1) 摘要，全文串不过宿主框架 state（性能契约）。 */
export interface KernelSummary {
  /** !doc.eq(baselineDoc)——CM Text 结构共享比较，非全文串比对。 */
  dirty: boolean
  /** 1-based 行号选区；空文档为 null。 */
  selection: DispatchSelection | null
  lineCount: number
  /** 光标行列（E2-P0：状态栏 Ln,Col 数据面）；空文档为 null。 */
  cursor: { line: number; col: number } | null
}

/** 宿主经此句柄取全文/做外部替换——宿主不持有内容全文 state。 */
export interface FileCodeEditorApi {
  getDoc(): string
  /**
   * 外部磁盘快照整体替换（首次装载后的安全刷新）。baseline 给出时同一事务内推进
   * 磁盘锚点（摘要只发一次、dirty 不抖动）；markChanged 时按旧文档逐行比较落
   * 变更行 decoration（旧文档 >5000 行放弃标记，沿用 changedLineNumbers 上限）。
   */
  replaceDoc(text: string, options?: { baseline?: string; markChanged?: boolean }): void
  /** 推进磁盘锚点但不改文档（保存回执：文档已与磁盘一致或保留更新的编辑）。 */
  advanceBaseline(baseline: string): void
  /** 保存成功后清除「外部改动」行标记。 */
  clearChangedMarks(): void
}

export interface KernelCallbacks {
  onSummaryChange?: (summary: KernelSummary) => void
  onSave?: () => void
}

export interface FileCodeMirrorKernel {
  view: EditorView
  api: FileCodeEditorApi
  setEditable(editable: boolean): void
  setBaseline(baseline: string): void
  reveal(line?: number): void
  destroy(): void
}

const setChangedLinesEffect = StateEffect.define<readonly number[]>()

const changedLinesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setChangedLinesEffect)) continue
      const builder = new RangeSetBuilder<Decoration>()
      for (const lineNumber of effect.value) {
        if (lineNumber < 1 || lineNumber > tr.state.doc.lines) continue
        const line = tr.state.doc.line(lineNumber)
        builder.add(line.from, line.from, Decoration.line({ class: 'file-line-changed' }))
      }
      next = builder.finish()
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

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
  { tag: tags.comment, color: 'var(--syn-cmt, #65737e)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-lit, #d08770)' },
  { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--syn-ent, #ebcb8b)' },
  { tag: [tags.variableName, tags.labelName], color: 'var(--syn-var, #c0c5ce)' },
  { tag: tags.propertyName, color: 'var(--syn-prop, #c0c5ce)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-fn, #8fa1b3)' },
  { tag: tags.heading, color: 'var(--syn-mh, #65737e)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--accent)' },
  { tag: tags.invalid, color: 'var(--danger)' },
])

export function createFileCodeMirrorKernel(
  parent: HTMLElement,
  options: {
    path: string
    initialContent: string
    baseline: string
    editable: boolean
    callbacks: KernelCallbacks
  },
): FileCodeMirrorKernel {
  const { path, initialContent, editable, callbacks } = options
  const language = new Compartment()
  const readonly = new Compartment()
  const languageAbort = new AbortController()
  let disposed = false
  let baselineDoc = Text.of(options.baseline.split('\n'))
  let lastSummary: KernelSummary | null = null

  const emitSummary = (view: EditorView) => {
    const doc = view.state.doc
    const selection = view.state.selection.main
    const cursorLine = doc.lineAt(selection.head)
    const summary: KernelSummary = {
      dirty: !doc.eq(baselineDoc),
      selection: doc.length === 0 ? null : {
        startLine: doc.lineAt(selection.from).number,
        endLine: doc.lineAt(selection.to).number,
      },
      lineCount: doc.lines,
      cursor: doc.length === 0 ? null : { line: cursorLine.number, col: selection.head - cursorLine.from + 1 },
    }
    const last = lastSummary
    if (last
      && last.dirty === summary.dirty
      && last.lineCount === summary.lineCount
      && last.selection?.startLine === summary.selection?.startLine
      && last.selection?.endLine === summary.selection?.endLine
      && last.cursor?.line === summary.cursor?.line
      && last.cursor?.col === summary.cursor?.col
    ) return
    lastSummary = summary
    callbacks.onSummaryChange?.(summary)
  }

  // issue #69：编辑态 tab 列宽与只读投影同源（读契约 token，见 resolveTabSize）。
  const view = new EditorView({
    doc: initialContent,
    parent,
    extensions: [
      basicSetup,
      EditorState.tabSize.of(resolveTabSize(parent)),
      readonly.of([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]),
      changedLinesField,
      keymap.of([{
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          callbacks.onSave?.()
          return true
        },
      }]),
      syntaxHighlighting(fileEditorHighlightStyle),
      language.of([]),
      EditorView.contentAttributes.of({ 'aria-label': `编辑 ${path}`, spellcheck: 'false' }),
      EditorView.updateListener.of(update => {
        if (update.docChanged || update.selectionSet) emitSummary(update.view)
      }),
    ],
  })

  const api: FileCodeEditorApi = {
    getDoc: () => view.state.doc.toString(),
    replaceDoc: (text, replaceOptions = {}) => {
      const current = view.state.doc
      const previousText = current.toString()
      let changed: readonly number[] = []
      if (replaceOptions.markChanged && previousText.length > 0 && previousText !== text) {
        changed = current.lines <= 5000 ? changedLineNumbers(previousText, text) : []
      }
      if (replaceOptions.baseline !== undefined) baselineDoc = Text.of(replaceOptions.baseline.split('\n'))
      view.dispatch({
        changes: { from: 0, to: current.length, insert: text },
        effects: setChangedLinesEffect.of(changed),
      })
    },
    advanceBaseline: (value) => {
      baselineDoc = Text.of(value.split('\n'))
      emitSummary(view)
    },
    clearChangedMarks: () => {
      view.dispatch({ effects: setChangedLinesEffect.of([]) })
    },
  }

  const loadLanguage = async () => {
    const provider = resolveFileLanguageProvider(path)
    if (provider) {
      try {
        const support = await provider.load(path, languageAbort.signal)
        if (support && !disposed) {
          view.dispatch({ effects: language.reconfigure(support) })
          return
        }
      } catch {
        // Provider failure/abort falls through to the built-in language data.
      }
    }
    const languages = await loadLanguageData()
    if (disposed || languageAbort.signal.aborted) return
    const description = LanguageDescription.matchFilename(languages, path)
    if (!description) return
    const support = await description.load()
    if (!disposed && !languageAbort.signal.aborted) {
      view.dispatch({ effects: language.reconfigure(support) })
    }
  }
  void loadLanguage().catch(() => {
    // 未安装/加载失败的语言按 CodeMirror 纯文本模式继续编辑。
  })

  return {
    view,
    api,
    setEditable(value: boolean) {
      view.dispatch({
        effects: readonly.reconfigure([EditorState.readOnly.of(!value), EditorView.editable.of(value)]),
      })
    },
    setBaseline(value: string) {
      baselineDoc = Text.of(value.split('\n'))
      emitSummary(view)
    },
    reveal(line?: number) {
      if (!line || line > view.state.doc.lines) return
      const target = view.state.doc.line(line)
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
      })
    },
    destroy() {
      disposed = true
      languageAbort.abort()
      view.destroy()
    },
  }
}
