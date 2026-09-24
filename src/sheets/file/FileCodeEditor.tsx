import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, Text } from '@codemirror/state'
import { Decoration, keymap, type DecorationSet } from '@codemirror/view'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { changedLineNumbers } from '../../domains/fileDispatch/fileDiff.ts'
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
  if (!host || typeof getComputedStyle !== 'function') return FILE_CODE_TAB_SIZE_FALLBACK
  const raw = getComputedStyle(host).getPropertyValue('--file-code-tab-size').trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FILE_CODE_TAB_SIZE_FALLBACK
}

/** 0-A1：内核摘要——键击路径只发这份 O(1) 摘要，全文串不过 React（性能契约）。 */
export interface KernelSummary {
  /** !doc.eq(baselineDoc)——CM Text 结构共享比较，非全文串比对。 */
  dirty: boolean
  /** 1-based 行号选区；空文档为 null（沿用旧 onSelectionChange 契约）。 */
  selection: DispatchSelection | null
  lineCount: number
  /** 光标行列（E2-P0：状态栏 Ln,Col 数据面）；空文档为 null。 */
  cursor: { line: number; col: number } | null
}

/** 0-A1：宿主经此句柄取全文/做外部替换——宿主不再持有内容全文 state。 */
export interface FileCodeEditorApi {
  getDoc(): string
  /**
   * 外部磁盘快照整体替换（首次装载/安全刷新）。baseline 给出时同一事务内推进
   * 磁盘锚点（摘要只发一次、dirty 不抖动）；markChanged 时按旧文档逐行比较落
   * 变更行 decoration（旧文档 >5000 行放弃标记，沿用旧 changedLineNumbers 上限）。
   */
  replaceDoc(text: string, options?: { baseline?: string; markChanged?: boolean }): void
  /** 推进磁盘锚点但不改文档（保存回执：文档已与磁盘一致或保留更新的编辑）。 */
  advanceBaseline(baseline: string): void
  /** 保存成功后清除「外部改动」行标记（这些标记描述的是磁盘相对打开时点的变化）。 */
  clearChangedMarks(): void
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

/**
 * File 模块私有的 CodeMirror 6 常驻单内核（0-A1 / issue #283）。
 *
 * 只读与编辑是**同一个** EditorView 的 editable compartment 两档——旧「手工 DOM
 * 投影 + highlightCode HTML 串」只读路径退役；changedLines 改 Decoration（StateField
 * 随事务 map 增量维护）、revealLine 收编 scrollIntoView、脏检查走 doc.eq(baselineDoc)
 * 结构共享比较。宿主只接触 KernelSummary 摘要与 FileCodeEditorApi 句柄，不再持有
 * 内容全文 state。语言包按路径异步装入（provider 优先，未知扩展名回退
 * language-data，保持纯文本可编辑）。
 */
export default function FileCodeEditor({ path, initialContent, baseline, editable = true, revealLine, onSummaryChange, onSave, apiRef }: {
  path: string
  /** 首次构造的文档内容；此后宿主经 api.replaceDoc 做外部替换，不再有 value prop。 */
  initialContent: string
  /** 磁盘锚点（保存成功/重载后由宿主推进）；内核据此计算 dirty。 */
  baseline: string
  editable?: boolean
  revealLine?: number
  onSummaryChange?: (summary: KernelSummary) => void
  onSave?: () => void
  apiRef?: { current: FileCodeEditorApi | null }
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const baselineRef = useRef<Text>(Text.of(baseline.split('\n')))
  const lastSummaryRef = useRef<KernelSummary | null>(null)
  const languageCompartmentRef = useRef<Compartment | null>(null)
  if (!languageCompartmentRef.current) languageCompartmentRef.current = new Compartment()
  const readonlyCompartmentRef = useRef<Compartment | null>(null)
  if (!readonlyCompartmentRef.current) readonlyCompartmentRef.current = new Compartment()
  const callbacksRef = useRef({ onSummaryChange, onSave })
  callbacksRef.current = { onSummaryChange, onSave }

  useEffect(() => {
    const parent = hostRef.current
    if (!parent || !languageCompartmentRef.current || !readonlyCompartmentRef.current) return
    const language = languageCompartmentRef.current
    const readonly = readonlyCompartmentRef.current
    const languageAbort = new AbortController()
    let disposed = false
    // issue #69：编辑态 tab 列宽与只读投影同源（读契约 token，见 resolveTabSize）。
    const tabSize = resolveTabSize(parent)

    const emitSummary = (view: EditorView) => emitSummaryOf(view, baselineRef, lastSummaryRef, callbacksRef)

    const view = new EditorView({
      doc: initialContent,
      parent,
      extensions: [
        basicSetup,
        EditorState.tabSize.of(tabSize),
        readonly.of([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]),
        changedLinesField,
        keymap.of([{
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            callbacksRef.current.onSave?.()
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
    viewRef.current = view
    emitSummary(view)

    if (apiRef) {
      apiRef.current = {
        getDoc: () => view.state.doc.toString(),
        replaceDoc: (text, options = {}) => {
          const current = view.state.doc
          const previousText = current.toString()
          let changed: readonly number[] = []
          if (options.markChanged && previousText.length > 0 && previousText !== text) {
            changed = current.lines <= 5000 ? changedLineNumbers(previousText, text) : []
          }
          if (options.baseline !== undefined) baselineRef.current = Text.of(options.baseline.split('\n'))
          view.dispatch({
            changes: { from: 0, to: current.length, insert: text },
            effects: setChangedLinesEffect.of(changed),
          })
        },
        advanceBaseline: (value) => {
          baselineRef.current = Text.of(value.split('\n'))
          emitSummary(view)
        },
        clearChangedMarks: () => {
          view.dispatch({ effects: setChangedLinesEffect.of([]) })
        },
      }
    }

    const loadLanguage = async () => {
      const provider = resolveFileLanguageProvider(path)
      if (provider) {
        try {
          const support = await provider.load(path, languageAbort.signal)
          if (support && !disposed && viewRef.current === view) {
            view.dispatch({ effects: language.reconfigure(support) })
            return
          }
        } catch {
          // Provider failure/abort falls through to the built-in language data.
        }
      }
      const languages = await loadLanguageData()
      if (disposed || viewRef.current !== view || languageAbort.signal.aborted) return
      const description = LanguageDescription.matchFilename(languages, path)
      if (!description) return
      const support = await description.load()
      if (!disposed && viewRef.current === view && !languageAbort.signal.aborted) {
        view.dispatch({ effects: language.reconfigure(support) })
      }
    }
    void loadLanguage().catch(() => {
      // 未安装/加载失败的语言按 CodeMirror 纯文本模式继续编辑。
    })

    return () => {
      disposed = true
      languageAbort.abort()
      viewRef.current = null
      if (apiRef) apiRef.current = null
      view.destroy()
    }
    // FileTabView 以 path 作为 key；单个实例只对应一个文档与语言生命周期。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 磁盘锚点推进（保存回执）：内核内 O(结构) 重算 dirty 并发摘要。
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    baselineRef.current = Text.of(baseline.split('\n'))
    emitSummaryOf(view, baselineRef, lastSummaryRef, callbacksRef)
    // baseline 字符串是锚点事实；path 仅随 key 重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline])

  // editable 翻转（0-A1 阶段仍是显式「编辑/退出」交互；0-A2 起常态为 true）。
  useEffect(() => {
    const view = viewRef.current
    if (!view || !readonlyCompartmentRef.current) return
    view.dispatch({
      effects: readonlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    })
  }, [editable])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !revealLine || revealLine > view.state.doc.lines) return
    const line = view.state.doc.line(revealLine)
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
  }, [revealLine])

  return <div ref={hostRef} className="file-code-editor" data-file-code-layout="shared" data-path={path} />
}

function emitSummaryOf(
  view: EditorView,
  baselineRef: { current: Text },
  lastSummaryRef: { current: KernelSummary | null },
  callbacksRef: { current: { onSummaryChange?: (summary: KernelSummary) => void } },
): void {
  const doc = view.state.doc
  const selection = view.state.selection.main
  const cursorLine = doc.lineAt(selection.head)
  const summary: KernelSummary = {
    dirty: !doc.eq(baselineRef.current),
    selection: doc.length === 0 ? null : {
      startLine: doc.lineAt(selection.from).number,
      endLine: doc.lineAt(selection.to).number,
    },
    lineCount: doc.lines,
    cursor: doc.length === 0 ? null : { line: cursorLine.number, col: selection.head - cursorLine.from + 1 },
  }
  const last = lastSummaryRef.current
  if (last
    && last.dirty === summary.dirty
    && last.lineCount === summary.lineCount
    && last.selection?.startLine === summary.selection?.startLine
    && last.selection?.endLine === summary.selection?.endLine
    && last.cursor?.line === summary.cursor?.line
    && last.cursor?.col === summary.cursor?.col
  ) return
  lastSummaryRef.current = summary
  callbacksRef.current.onSummaryChange?.(summary)
}
