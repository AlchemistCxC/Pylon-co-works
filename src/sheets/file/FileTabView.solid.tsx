import { createEffect, createMemo, createSignal, onCleanup, For, Show, untrack } from 'solid-js'
import { render } from 'solid-js/web'
import { sanitizeHtml } from '../../components/chat/htmlSanitizer'
import { highlightCode } from '../../components/chat/codeHighlight'
import { normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts.ts'
import { changedLineNumbers } from '../../domains/fileDispatch/fileDiff.ts'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { useWorkspaceStore, touchedFileVersionKey } from '../../workspaceStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import type { AgentContext } from '../../agentContext'
import { languageFromPath } from './fileSheetState.ts'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { legacyFileProvider, legacyTarget } from './legacyFileProvider.ts'
import { createZustandSignal } from '../solidStoreBridge.ts'
import FileCodeEditor from './FileCodeEditor.solid'
import MarkdownPreview from './MarkdownPreview.solid'

export interface FileSaveReceipt {
  version: number
  expectedContent: string
  persistedContent: string
}

export interface FileTabViewProps {
  target?: WorkspaceTarget | null
  /** @deprecated direct component compatibility. */ source?: string | null
  provider?: FileProvider | null
  path: string
  revealLine?: number
  context?: AgentContext | null
  editing?: boolean
  onTruncated: (truncated: boolean) => void
  onContentReady?: (content: string) => void
  onContentChange?: (content: string) => void
  onExternalChange?: () => void
  onSelectionChange?: (selection: DispatchSelection | null) => void
  onSelectionInvalidated?: () => void
  onSave?: () => void
  saveAnchorToken?: number
  saveReceipt?: FileSaveReceipt | null
}

/**
 * FileTabView — 文件视图（W2-04 只读 + I08-A-FE-02 编辑模式，#279 第 2 梯队 Solid 实体）。
 *
 * 与 React 版逐行为同构迁移。跨桥 props 经 SolidMount 响应式通道进入；`latest()` 的
 * 字段一律先过 `createMemo`（引用等值去重——语义等价 React 的 deps 数组），事件回调类
 * 字段在调用点经 `latest()` 现场取新（untrack，绝不把 props 信号本身泄进依赖集）。
 * saveReceipt/saveAnchorToken/editing 等可变字段的响应性由此保证（保存锚点/脏判定是
 * 数据完整性契约）。
 *
 * 只读：readText → 代码（highlightCode + sanitizeHtml 安全路径，行号 gutter）或
 * markdown（MarkdownPreview.solid，wasm 计算核解析，无 gutter）；truncated 状态可读。
 * 编辑：CodeMirror 6 承载内容，输入经 onContentChange 上报（不落盘）；选区经
 * onSelectionChange 报 1-based 行号。dirty 感知 touchVersion 重载：编辑中磁盘变化
 * 时若用户有未保存编辑 → onExternalChange 上报冲突（绝不静默覆盖）；无编辑 → 安全
 * 刷新到磁盘。
 */
export default function FileTabView(p: { latest: () => FileTabViewProps }) {
  const value = p.latest
  // 效果体/异步回调内取最新 props 用（untrack：不把 props 信号泄进依赖集）。
  const latest = () => untrack(value)

  // ── 响应式字段（memo 引用等值去重 ≡ React deps 数组）──
  const explicitTarget = createMemo(() => value().target)
  const source = createMemo(() => value().source)
  const explicitProvider = createMemo(() => value().provider)
  const path = createMemo(() => value().path)
  const revealLine = createMemo(() => value().revealLine)
  const context = createMemo(() => value().context)
  const editing = createMemo(() => value().editing === true)
  const saveAnchorToken = createMemo(() => value().saveAnchorToken)
  const saveReceipt = createMemo(() => value().saveReceipt ?? null)

  const target = createMemo(() => {
    const resolved = explicitTarget()
    return resolved === undefined ? legacyTarget(source() ?? null) : resolved
  })
  const provider = createMemo(() => explicitProvider() === undefined && source() ? legacyFileProvider : explicitProvider() ?? null)
  const targetKey = createMemo(() => workspaceTargetKey(target()))
  const errorKey = createMemo(() => `file-tab:${targetKey() ?? 'none'}:${path()}`)
  const isMarkdown = createMemo(() => /\.(md|markdown)$/i.test(path()))

  // ── 状态 ──
  const [content, setContent] = createSignal('')
  const [highlighted, setHighlighted] = createSignal<{ html: string; lang: string } | null>(null)
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [changedLines, setChangedLines] = createSignal<number[]>([])

  // ── 非响应式锚点/守卫（与 React 版 ref 同语义）──
  let requestContext: SourceRequestContext = { source: null, generation: 0 }
  let diskRef: string | null = null
  let saveAnchorRef = 0
  let saveReceiptRef = 0
  let readViewElement: HTMLDivElement | undefined
  let highlightRequest = 0
  let editingPrev = false

  // W2-09：版本戳订阅——agent 工具改动该文件时递增，触发 300ms debounce 重拉
  const touchVersion = createZustandSignal(useWorkspaceStore, s => {
    const currentTarget = target()
    const currentPath = path()
    const currentContext = context()
    return (currentTarget && currentPath && currentContext)
      ? s.touchVersions[touchedFileVersionKey(currentContext, currentPath)]
      : undefined
  })

  const fetchText = (requestTarget: WorkspaceTarget, requestPath: string): Promise<{ text: string; truncated: boolean } | null> =>
    (provider() ? provider()!.readText(requestTarget, requestPath) : Promise.resolve(null)).then(raw => {
      const text = normalizeWorkspaceText(raw)
      return text ? { text: text.content, truncated: text.truncated } : null
    })

  const invalidateHighlight = () => {
    highlightRequest += 1
    setHighlighted(null)
  }

  const requestHighlight = (requestPath: string, text: string) => {
    const requestId = ++highlightRequest
    const lang = languageFromPath(requestPath)
    // Markdown has its own renderer, and unknown/plain text has no grammar;
    // avoid leaving a stale highlighted projection visible for either path.
    if (lang === 'markdown' || lang === 'text') {
      setHighlighted(null)
      return
    }
    setHighlighted(null)
    void highlightCode(lang, text).then(html => {
      if (
        requestId !== highlightRequest
        || requestPath !== path()
        || editing()
      ) return
      if (html) setHighlighted({ html, lang })
    }).catch(() => {
      // Plain-text rendering remains the safe fallback when a provider or
      // grammar cannot be loaded (including offline/Tauri asset failures).
    })
  }

  const loadContent = (showChanged: boolean) => {
    // target 是宿主每渲染构造的对象(身份不稳定),只 untrack 取值——加载的响应式触发键
    // 是 targetKey/path/provider(React 版 deps 同口径),target 身份变化不得引发重载。
    const currentTarget = untrack(target)
    const currentTargetKey = targetKey()
    const currentProvider = untrack(provider)
    const requestPath = path()
    if (!currentTarget || !currentTargetKey || !currentProvider || !requestPath) return
    setLoading(true)
    setError('')
    requestContext = { source: currentTargetKey, generation: requestContext.generation + 1 }
    const token = beginSourceRequest(requestContext, currentTargetKey)
    fetchText(currentTarget, requestPath).then(loaded => {
      if (!isCurrentSourceRequest(requestContext, token) || requestPath !== path()) return
      if (!loaded) {
        setLoading(false)
        setError('文件读取响应异常，请重试')
        reportRuntimeError('读取文件', new Error('文件读取响应异常，请重试'), undefined, {
          key: errorKey(),
          scope: { kind: 'sheet', id: `file-tab:${currentTargetKey ?? 'none'}` },
          source: 'file.tab',
          recovery: { kind: 'open-runtime-log', sheetId: `file-tab:${currentTargetKey ?? 'none'}` },
        })
        return
      }
      setLoading(false)
      setContent(previous => {
        if (showChanged && previous && previous !== loaded.text) {
          setChangedLines(previous.split('\n').length <= 5000 ? changedLineNumbers(previous, loaded.text) : [])
          latest().onSelectionInvalidated?.()
        }
        return loaded.text
      })
      diskRef = loaded.text
      latest().onTruncated(loaded.truncated)
      latest().onContentReady?.(loaded.text)
      resolveRuntimeErrors({ key: errorKey() })
      // Keep highlighting tied to the same guarded file snapshot. The helper
      // also owns edit-mode invalidation so leaving the editor rehydrates the
      // read-only projection for the current (possibly unsaved) text.
      if (isCurrentSourceRequest(requestContext, token) && requestPath === path()) {
        requestHighlight(requestPath, loaded.text)
      }
    }).catch(err => {
      if (isCurrentSourceRequest(requestContext, token) && requestPath === path()) {
        setLoading(false)
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError('读取文件', err, undefined, {
          key: errorKey(),
          scope: { kind: 'sheet', id: `file-tab:${currentTargetKey ?? 'none'}` },
          source: 'file.tab',
          recovery: { kind: 'open-runtime-log', sheetId: `file-tab:${currentTargetKey ?? 'none'}` },
        })
      }
    })
  }

  // I08-A-FE-02：编辑中探测磁盘——用户编辑与磁盘一致 → 安全刷新；不一致 → 上报冲突
  const probeDisk = () => {
    const currentTarget = untrack(target)
    const currentTargetKey = targetKey()
    const currentProvider = untrack(provider)
    const requestPath = path()
    if (!currentTarget || !currentTargetKey || !currentProvider || !requestPath) return
    requestContext = { source: currentTargetKey, generation: requestContext.generation + 1 }
    const token = beginSourceRequest(requestContext, currentTargetKey)
    fetchText(currentTarget, requestPath).then(loaded => {
      if (!loaded || !isCurrentSourceRequest(requestContext, token) || requestPath !== path()) return
      if (loaded.text === content()) return
      // 磁盘内容与上次锚点一致 → 无外部修改：保留未保存编辑，不误报冲突
      if (loaded.text === diskRef) return
      if (diskRef === content()) {
        // 无用户编辑：刷新显示到磁盘（不产生冲突）
        setContent(loaded.text)
        diskRef = loaded.text
        latest().onTruncated(loaded.truncated)
        latest().onContentReady?.(loaded.text)
      } else {
        // 用户有未保存编辑：不覆盖，上报外部修改冲突
        latest().onExternalChange?.()
      }
    }).catch(() => {})
  }

  // 目标/文件/provider 变化 → 全量重置 + 读取（React 版 [targetKey, path, provider] effect）
  createEffect(() => {
    const currentTargetKey = targetKey()
    const currentPath = path()
    requestContext = advanceSourceContext(requestContext, currentTargetKey)
    setContent('')
    setHighlighted(null)
    setError('')
    setLoading(false)
    setChangedLines([])
    diskRef = null
    if (!untrack(target) || !currentPath) return
    loadContent(false)
    onCleanup(() => {
      requestContext = advanceSourceContext(requestContext, null)
    })
  })

  // Entering edit mode hides the read-only projection; leaving it must build a
  // fresh projection from the editor's current value instead of waiting for a
  // disk reload (which would discard unsaved edits).
  createEffect(() => {
    const wasEditing = editingPrev
    const isEditing = editing()
    editingPrev = isEditing
    if (isEditing) {
      invalidateHighlight()
      return
    }
    if (wasEditing && content() && path() && !isMarkdown()) requestHighlight(path(), content())
    // `content` is intentionally included: an edit can be committed between
    // the mode toggle and this effect's flush; the latest value wins.
  })

  // W2-09：版本戳变化 → 300ms debounce；编辑中改走探测（不静默覆盖），只读保持重拉。
  // 依赖不含 editing（否则切编辑模式重跑 effect → 退出编辑静默覆盖未保存修改、重进编辑误报冲突）；
  // 定时器回调内现场读 editing()（untrack 语境，恒为新值），且 content !== diskRef
  // （存在未保存编辑）时也走探测路径。
  createEffect(() => {
    const currentTouch = touchVersion()
    if (currentTouch === undefined || !untrack(target) || !path()) return
    const timer = window.setTimeout(() => {
      if (editing() || content() !== diskRef) probeDisk()
      else loadContent(true)
    }, 300)
    onCleanup(() => window.clearTimeout(timer))
  })

  // I08-A-FE-02：保存成功/覆盖/重新加载后磁盘锚点推进 → 重拉对齐（changedLines 归零、内容与磁盘一致）
  createEffect(() => {
    const token = saveAnchorToken()
    if (token === undefined || token === saveAnchorRef || !untrack(target) || !path()) return
    saveAnchorRef = token
    loadContent(false)
  })

  // A successful save advances the disk anchor without blindly re-reading. If the
  // user typed while the write was in flight, preserve that newer editor content.
  createEffect(() => {
    const receipt = saveReceipt()
    const isEditing = editing()
    if (!receipt || receipt.version === saveReceiptRef) return
    saveReceiptRef = receipt.version
    const hasNewerEdits = content() !== receipt.expectedContent
    diskRef = receipt.persistedContent
    setChangedLines([])
    if (hasNewerEdits) return
    setContent(receipt.persistedContent)
    // A save receipt can arrive after leaving edit mode. Re-project the
    // persisted snapshot instead of clearing the read-only markup and leaving
    // the file unhighlighted until a later reload.
    if (isEditing) {
      invalidateHighlight()
    } else {
      requestHighlight(path(), receipt.persistedContent)
    }
  })

  // The editor branch does not consume line arrays.  Avoid splitting a large
  // buffer while CodeMirror owns the edit surface; materialise rows only for
  // the read-only projection.
  const codeLines = createMemo(() => editing() ? [] : content().split('\n'))
  const highlightedLines = createMemo(() => editing() ? null : highlighted()?.html.split('\n') ?? null)
  // Rendering a large file used to scan `changedLines` for every source line.
  // Keep the same line-level contract while making membership O(1).
  const changedLineSet = createMemo(() => new Set(changedLines()))
  const editorKey = createMemo(() => `${targetKey() ?? 'unknown'}:${path()}`)

  // 渲染模式：单一 keyed Show 分派。Solid 的 JSX 赋值会**急切实例化**子树——编辑器
  // 若在只读模式下被预创建，其 CodeMirror 会以游离 DOM 存在并永久 measure（jsdom 下
  // 每帧抛错）。keyed 分支保证子树只在模式命中时创建、离开即销毁。
  const viewMode = createMemo(() => {
    if (!target() || !provider()) return 'no-provider'
    if (error()) return 'error'
    if (loading()) return 'loading'
    return editing() ? 'edit' : 'read'
  })

  // revealLine 定位：read 投影落地后按行滚动（React 版 [content, revealLine, path] effect）
  createEffect(() => {
    const reveal = revealLine()
    const currentPath = path()
    if (!reveal || content().length === 0 || !currentPath) return
    const frame = window.requestAnimationFrame(() => {
      const line = readViewElement?.querySelector<HTMLElement>(`[data-line="${reveal}"]`)
      line?.scrollIntoView?.({ block: 'center' })
    })
    onCleanup(() => window.cancelAnimationFrame(frame))
  })

  return (
    <Show when={viewMode()} keyed>
      {mode => {
        if (mode === 'no-provider') return <div class="file-tab-view file-tab-empty">未安装可用的文件 provider</div>
        if (mode === 'error') return <div class="file-tab-view file-tab-error" role="status">文件读取失败，详情见右下角错误中心</div>
        if (mode === 'loading') return <div class="file-tab-view file-tab-loading" role="status">正在读取文件…</div>

        if (mode === 'edit') {
          // 编辑器按「每文档一实例」重建（React 版以 key 承载的契约），keyed Show 在
          // targetKey:path 变化时重建 CodeMirror 生命周期。
          return (
            <Show when={editorKey()} keyed>
              {_editorKey => (
                <div class="file-tab-view file-tab-edit" data-path={path()}>
                  <FileCodeEditor
                    path={path()}
                    value={content()}
                    revealLine={revealLine()}
                    onChange={nextValue => {
                      // Keep the dirty/snapshot ref in lockstep with CodeMirror's input;
                      // a save receipt may arrive before the state effect flushes.
                      setContent(nextValue)
                      invalidateHighlight()
                      latest().onContentChange?.(nextValue)
                    }}
                    onSelectionChange={selection => latest().onSelectionChange?.(selection)}
                    onSave={() => latest().onSave?.()}
                  />
                </div>
              )}
            </Show>
          )
        }

        return (
          <div ref={element => { readViewElement = element }} class="file-tab-view" data-path={path()}>
            <Show
              when={isMarkdown()}
              fallback={
                <div class="file-tab-code" data-file-code-layout="shared" data-lang={highlighted()?.lang ?? languageFromPath(path())} data-highlighted={highlighted() ? 'true' : 'false'}>
                  <div class="file-tab-gutter">
                    <For each={codeLines()}>{(_, index) => <div class="file-tab-gutter-line">{index() + 1}</div>}</For>
                  </div>
                  <pre class="file-tab-pre">
                    <Show
                      when={highlightedLines()}
                      keyed
                      fallback={
                        <For each={codeLines()}>{(line, index) => (
                          <code class="file-tab-line" data-line={index() + 1} data-revealed={revealLine() === index() + 1 ? 'true' : undefined} data-changed={changedLineSet().has(index() + 1) ? 'true' : undefined}>{line}</code>
                        )}</For>
                      }
                    >
                      {lines => (
                        <For each={lines}>{(line, index) => (
                          <code class="file-tab-line" data-line={index() + 1} data-revealed={revealLine() === index() + 1 ? 'true' : undefined} data-changed={changedLineSet().has(index() + 1) ? 'true' : undefined} innerHTML={sanitizeHtml(line || '&nbsp;')} />
                        )}</For>
                      )}
                    </Show>
                  </pre>
                </div>
              }
            >
              <div class="file-tab-md">
                <MarkdownPreview latest={() => ({ text: content() })} />
              </div>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}

/** React 薄桥（FileTabView.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export function renderFileTabView(container: HTMLElement, latest: () => FileTabViewProps): () => void {
  return render(() => <FileTabView latest={latest} />, container)
}
