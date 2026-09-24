import { useEffect, useRef, useState } from 'react'
import { normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts.ts'
import { useWorkspaceStore, touchedFileVersionKey } from '../../workspaceStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import type { AgentContext } from '../../agentContext'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { legacyFileProvider, legacyTarget } from './legacyFileProvider.ts'
import FileCodeEditor, { type FileCodeEditorApi, type KernelSummary } from './FileCodeEditor.tsx'

export interface FileSaveReceipt {
  version: number
  expectedContent: string
  persistedContent: string
}

export type { KernelSummary, FileCodeEditorApi }

/**
 * FileTabView — 文件视图数据编排（0-A1 / issue #283 内核合一后）。
 *
 * 渲染恒为 CodeMirror 常驻单内核（FileCodeEditor）：0-A2 起默认可写，只读仅物理
 * 例外（writable=false）。旧「手工 DOM 投影 + highlightCode/sanitizeHtml +
 * MarkdownPreview 只读分支」退役（markdown 渲染态切换归阶段一 1-A1，裁决：md 默认
 * 源码态）。本组件只负责：
 * read_workspace_text 装载（source guard 防串）、touchVersion 感知（编辑中走
 * probeDisk 不静默覆盖，无编辑安全刷新并落变更行 decoration）、saveReceipt 锚点
 * 推进、truncated 上报。内容全文不过 React state——宿主经 apiRef 句柄取全文。
 */
export default function FileTabView({ target: explicitTarget, source, provider: explicitProvider, path, revealLine, context, writable = true, baseline, onTruncated, onContentReady, onExternalChange, onSelectionInvalidated, onSummaryChange, onSave, saveAnchorToken, saveReceipt, apiRef }: {
  target?: WorkspaceTarget | null
  /** @deprecated direct component compatibility. */ source?: string | null
  provider?: FileProvider | null
  path: string
  revealLine?: number
  context?: AgentContext | null
  /** 0-A2 默认可写：仅物理例外（truncated）传 false → 内核只读档。 */
  writable?: boolean
  /** 磁盘锚点（宿主持有；保存回执/重载后推进），透传内核计算 dirty。 */
  baseline?: string
  onTruncated: (truncated: boolean) => void
  onContentReady?: (content: string) => void
  onExternalChange?: () => void
  onSelectionInvalidated?: () => void
  onSummaryChange?: (summary: KernelSummary) => void
  onSave?: () => void
  saveAnchorToken?: number
  saveReceipt?: FileSaveReceipt | null
  apiRef?: { current: FileCodeEditorApi | null }
}) {
  const target = explicitTarget === undefined ? legacyTarget(source) : explicitTarget
  const provider = explicitProvider === undefined && source ? legacyFileProvider : explicitProvider ?? null
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // 首次装载成功的快照 = 内核 initialContent；此后外部刷新走 api.replaceDoc 不重挂。
  // loadedRef 是「是否已完成首载」的真源（state 闭包在 reset effect 里是旧值）。
  const [loadedText, setLoadedText] = useState<string | null>(null)
  const loadedRef = useRef<string | null>(null)
  const requestContext = useRef<SourceRequestContext>({ source: null, generation: 0 })
  const diskRef = useRef<string | null>(null)
  const saveAnchorRef = useRef<number>(0)
  const saveReceiptRef = useRef<number>(0)
  // 可写 ref：touchVersion 重载 effect 不依赖 writable（否则翻转重跑 effect 误报冲突）
  const writableRef = useRef(true)
  useEffect(() => { writableRef.current = writable !== false }, [writable])
  // W2-09：版本戳订阅——agent 工具改动该文件时递增，触发 300ms debounce 重拉
  const targetKey = workspaceTargetKey(target)
  const errorKey = `file-tab:${targetKey ?? 'none'}:${path}`
  const touchVersion = useWorkspaceStore(s => (target && path && context) ? s.touchVersions[touchedFileVersionKey(context, path)] : undefined)

  const editorContent = (): string => apiRef?.current?.getDoc() ?? ''

  const fetchText = (requestTarget: WorkspaceTarget, requestPath: string): Promise<{ text: string; truncated: boolean } | null> =>
    (provider ? provider.readText(requestTarget, requestPath) : Promise.resolve(null)).then(raw => {
      const text = normalizeWorkspaceText(raw)
      return text ? { text: text.content, truncated: text.truncated } : null
    })

  const loadContent = (showChanged: boolean) => {
    if (!target || !targetKey || !provider || !path) return
    setLoading(true)
    setError('')
    requestContext.current = { source: targetKey, generation: requestContext.current.generation + 1 }
    const token = beginSourceRequest(requestContext.current, targetKey)
    const requestPath = path
    const isFirstLoad = loadedRef.current === null
    fetchText(target, path).then(loaded => {
      if (!isCurrentSourceRequest(requestContext.current, token) || requestPath !== path) return
      if (!loaded) {
        setLoading(false)
        setError('文件读取响应异常，请重试')
        reportRuntimeError('读取文件', new Error('文件读取响应异常，请重试'), undefined, {
          key: errorKey,
          scope: { kind: 'sheet', id: `file-tab:${targetKey ?? 'none'}` },
          source: 'file.tab',
          recovery: { kind: 'open-runtime-log', sheetId: `file-tab:${targetKey ?? 'none'}` },
        })
        return
      }
      setLoading(false)
      if (isFirstLoad || !apiRef?.current) {
        // 首载，或内核不在挂载位（上次 error 卸载后恢复）：回退首载路径让内核以
        // 新磁盘快照重挂——否则 stale initialContent + 新 baseline 会产生伪 dirty，
        // Ctrl+S 会以匹配的 expectedBaseline 把旧内容静默写回（AC-1 旁路）。
        loadedRef.current = loaded.text
        setLoadedText(loaded.text)
      } else {
        apiRef.current.replaceDoc(loaded.text, { baseline: loaded.text, markChanged: showChanged })
        if (showChanged) onSelectionInvalidated?.()
      }
      diskRef.current = loaded.text
      onTruncated(loaded.truncated)
      onContentReady?.(loaded.text)
      resolveRuntimeErrors({ key: errorKey })
    }).catch(err => {
      if (isCurrentSourceRequest(requestContext.current, token) && requestPath === path) {
        setLoading(false)
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError('读取文件', err, undefined, {
          key: errorKey,
          scope: { kind: 'sheet', id: `file-tab:${targetKey ?? 'none'}` },
          source: 'file.tab',
          recovery: { kind: 'open-runtime-log', sheetId: `file-tab:${targetKey ?? 'none'}` },
        })
      }
    })
  }

  // I08-A-FE-02：编辑中探测磁盘——用户编辑与磁盘一致 → 安全刷新；不一致 → 上报冲突
  const probeDisk = () => {
    if (!target || !targetKey || !provider || !path) return
    requestContext.current = { source: targetKey, generation: requestContext.current.generation + 1 }
    const token = beginSourceRequest(requestContext.current, targetKey)
    const requestPath = path
    if (!apiRef?.current) return
    const editorNow = editorContent()
    fetchText(target, path).then(loaded => {
      if (!loaded || !isCurrentSourceRequest(requestContext.current, token) || requestPath !== path) return
      if (loaded.text === editorNow) return
      // 磁盘内容与上次锚点一致 → 无外部修改：保留未保存编辑，不误报冲突
      if (loaded.text === diskRef.current) return
      if (diskRef.current === editorNow) {
        // 无用户编辑：刷新显示到磁盘（不产生冲突）
        apiRef?.current?.replaceDoc(loaded.text, { baseline: loaded.text })
        diskRef.current = loaded.text
        onTruncated(loaded.truncated)
        onContentReady?.(loaded.text)
      } else {
        // 用户有未保存编辑：不覆盖，上报外部修改冲突
        onExternalChange?.()
      }
    }).catch(() => {})
  }

  useEffect(() => {
    requestContext.current = advanceSourceContext(requestContext.current, targetKey)
    loadedRef.current = null
    setLoadedText(null)
    setError('')
    setLoading(false)
    diskRef.current = null
    if (!target || !path) return
    loadContent(false)
    return () => {
      requestContext.current = advanceSourceContext(requestContext.current, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, path, provider])

  // W2-09：版本戳变化 → 300ms debounce；编辑中改走探测（不静默覆盖），只读保持重拉。
  // 依赖不含 editing（否则切编辑模式重跑 effect → 退出编辑静默覆盖未保存修改、重进编辑误报冲突）；
  // 定时器回调内读 editingRef 取最新编辑态，且编辑器内容 !== diskRef（存在未保存编辑）时也走探测路径。
  useEffect(() => {
    if (touchVersion === undefined || !target || !path) return
    const timer = window.setTimeout(() => {
      if (writableRef.current || editorContent() !== diskRef.current) probeDisk()
      else loadContent(true)
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchVersion, targetKey, path])

  // I08-A-FE-02：保存成功/覆盖/重新加载后磁盘锚点推进 → 重拉对齐（变更行归零、内容与磁盘一致）
  useEffect(() => {
    if (saveAnchorToken === undefined || saveAnchorToken === saveAnchorRef.current || !target || !path) return
    saveAnchorRef.current = saveAnchorToken
    loadContent(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveAnchorToken, targetKey, path])

  // A successful save advances the disk anchor without blindly re-reading. If the
  // user typed while the write was in flight, preserve that newer editor content.
  useEffect(() => {
    if (!saveReceipt || saveReceipt.version === saveReceiptRef.current) return
    saveReceiptRef.current = saveReceipt.version
    const hasNewerEdits = editorContent() !== saveReceipt.expectedContent
    diskRef.current = saveReceipt.persistedContent
    apiRef?.current?.clearChangedMarks()
    if (!hasNewerEdits) {
      apiRef?.current?.advanceBaseline(saveReceipt.persistedContent)
    }
    // `saveReceipt.version` is the event identity; the doc/anchor semantics are
    // kernel-side once the receipt lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveReceipt])

  if (!target || !provider) return <div className="file-tab-view file-tab-empty">未安装可用的文件 provider</div>
  if (error) return <div className="file-tab-view file-tab-error" role="status">文件读取失败，详情见右下角错误中心</div>
  // loading 只在首载（内核未挂载）时展示；后续外部刷新保持内核挂载——卸载会销毁
  // 文档与 api 句柄，replaceDoc 无从落地（刷新语义 = 同一实例上整体替换）。
  if (loading && loadedText === null) return <div className="file-tab-view file-tab-loading" role="status">正在读取文件…</div>
  if (loadedText === null) return null

  return (
    <div className="file-tab-view file-tab-edit" data-path={path}>
      <FileCodeEditor
        key={`${targetKey ?? 'unknown'}:${path}`}
        path={path}
        initialContent={loadedText}
        baseline={baseline ?? loadedText}
        editable={writable !== false}
        revealLine={revealLine}
        onSummaryChange={onSummaryChange}
        onSave={onSave}
        apiRef={apiRef}
      />
    </div>
  )
}
