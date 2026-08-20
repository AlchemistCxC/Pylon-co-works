import { useEffect, useMemo, useRef, useState, Suspense } from 'react'
import { sanitizeHtml } from '../../components/chat/htmlSanitizer'
import { highlightCode } from '../../components/chat/codeHighlight'
import { MarkdownRenderer } from '../../components/chat/markdownLazy'
import { normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts.ts'
import { changedLineNumbers } from '../../domains/fileDispatch/fileDiff.ts'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { useWorkspaceStore, touchedFileVersionKey } from '../../workspaceStore'
import type { AgentContext } from '../../agentContext'
import { languageFromPath } from './fileSheetState.ts'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { legacyFileProvider, legacyTarget } from './legacyFileProvider.ts'
import FileCodeEditor from './FileCodeEditor.tsx'

/**
 * FileTabView — 文件视图（W2-04 只读 + I08-A-FE-02 编辑模式）。
 *
 * 只读：read_workspace_text → 代码（highlightCode + sanitizeHtml 安全路径，行号 gutter）或
 * markdown（复用导出 MarkdownRenderer，无 gutter）；truncated 状态可读。
 * 编辑：模块私有 CodeMirror 6 承载内容，输入经 onContentChange 上报（不落盘）；选区经
 * onSelectionChange 报 1-based 行号。dirty 感知 touchVersion 重载：编辑中磁盘变化
 * 时若用户有未保存编辑 → onExternalChange 上报冲突（绝不静默覆盖）；无编辑 → 安全
 * 刷新到磁盘。saveAnchorToken 递增（保存成功/覆盖/重新加载后）→ 重拉磁盘对齐锚点。
 */
export default function FileTabView({ target: explicitTarget, source, provider: explicitProvider, path, context, editing, onTruncated, onContentReady, onContentChange, onExternalChange, onSelectionChange, onSelectionInvalidated, saveAnchorToken }: {
  target?: WorkspaceTarget | null
  /** @deprecated direct component compatibility. */ source?: string | null
  provider?: FileProvider | null
  path: string
  context?: AgentContext | null
  editing?: boolean
  onTruncated: (truncated: boolean) => void
  onContentReady?: (content: string) => void
  onContentChange?: (content: string) => void
  onExternalChange?: () => void
  onSelectionChange?: (selection: DispatchSelection | null) => void
  onSelectionInvalidated?: () => void
  saveAnchorToken?: number
}) {
  const target = explicitTarget === undefined ? legacyTarget(source) : explicitTarget
  const provider = explicitProvider === undefined && source ? legacyFileProvider : explicitProvider ?? null
  const [content, setContent] = useState('')
  const [highlighted, setHighlighted] = useState<{ html: string; lang: string } | null>(null)
  const [error, setError] = useState('')
  const [changedLines, setChangedLines] = useState<number[]>([])
  const requestContext = useRef<SourceRequestContext>({ source: null, generation: 0 })
  // I08-A-FE-02：编辑器内容 ref（探针/选区用）+ 磁盘锚点 ref（区分"用户编辑"与"陈旧显示"）
  const contentRef = useRef('')
  const diskRef = useRef<string | null>(null)
  const saveAnchorRef = useRef<number>(0)
  // 编辑模式 ref：touchVersion 重载 effect 不依赖 editing（否则切编辑模式重跑 effect，
  // 退出编辑会 300ms 后 loadContent 静默覆盖未保存修改、重进编辑会误报冲突）
  const editingRef = useRef(false)
  useEffect(() => { editingRef.current = editing === true }, [editing])
  // W2-09：版本戳订阅——agent 工具改动该文件时递增，触发 300ms debounce 重拉
  const targetKey = workspaceTargetKey(target)
  const touchVersion = useWorkspaceStore(s => (target && path && context) ? s.touchVersions[touchedFileVersionKey(context, path)] : undefined)

  useEffect(() => { contentRef.current = content }, [content])

  const fetchText = (requestTarget: WorkspaceTarget, requestPath: string): Promise<{ text: string; truncated: boolean } | null> =>
    (provider ? provider.readText(requestTarget, requestPath) : Promise.resolve(null)).then(raw => {
      const text = normalizeWorkspaceText(raw)
      return text ? { text: text.content, truncated: text.truncated } : null
    })

  const loadContent = (showChanged: boolean) => {
    if (!target || !targetKey || !provider || !path) return
    requestContext.current = { source: targetKey, generation: requestContext.current.generation + 1 }
    const token = beginSourceRequest(requestContext.current, targetKey)
    const requestPath = path
    fetchText(target, path).then(loaded => {
      if (!loaded || !isCurrentSourceRequest(requestContext.current, token) || requestPath !== path) return
      setContent(previous => {
        if (showChanged && previous && previous !== loaded.text) {
          setChangedLines(previous.split('\n').length <= 5000 ? changedLineNumbers(previous, loaded.text) : [])
          onSelectionInvalidated?.()
        }
        return loaded.text
      })
      diskRef.current = loaded.text
      onTruncated(loaded.truncated)
      onContentReady?.(loaded.text)
      const lang = languageFromPath(requestPath)
      setHighlighted(null)
      highlightCode(lang, loaded.text).then(html => {
        if (html && isCurrentSourceRequest(requestContext.current, token) && requestPath === path) setHighlighted({ html, lang })
      }).catch(() => {})
    }).catch(err => {
      if (isCurrentSourceRequest(requestContext.current, token) && requestPath === path) setError(err instanceof Error ? err.message : String(err))
    })
  }

  // I08-A-FE-02：编辑中探测磁盘——用户编辑与磁盘一致 → 安全刷新；不一致 → 上报冲突
  const probeDisk = () => {
    if (!target || !targetKey || !provider || !path) return
    requestContext.current = { source: targetKey, generation: requestContext.current.generation + 1 }
    const token = beginSourceRequest(requestContext.current, targetKey)
    const requestPath = path
    fetchText(target, path).then(loaded => {
      if (!loaded || !isCurrentSourceRequest(requestContext.current, token) || requestPath !== path) return
      if (loaded.text === contentRef.current) return
      // 磁盘内容与上次锚点一致 → 无外部修改：保留未保存编辑，不误报冲突
      if (loaded.text === diskRef.current) return
      if (diskRef.current === contentRef.current) {
        // 无用户编辑：刷新显示到磁盘（不产生冲突）
        setContent(loaded.text)
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
    setContent('')
    setHighlighted(null)
    setError('')
    setChangedLines([])
    contentRef.current = ''
    diskRef.current = null
    if (!target || !path) return
    loadContent(false)
    return () => {
      requestContext.current = advanceSourceContext(requestContext.current, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, path])

  // W2-09：版本戳变化 → 300ms debounce；编辑中改走探测（不静默覆盖），只读保持重拉。
  // 依赖不含 editing（否则切编辑模式重跑 effect → 退出编辑静默覆盖未保存修改、重进编辑误报冲突）；
  // 定时器回调内读 editingRef 取最新编辑态，且 contentRef !== diskRef（存在未保存编辑）时也走探测路径。
  useEffect(() => {
    if (touchVersion === undefined || !target || !path) return
    const timer = window.setTimeout(() => {
      if (editingRef.current || contentRef.current !== diskRef.current) probeDisk()
      else loadContent(true)
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchVersion, targetKey, path])

  // I08-A-FE-02：保存成功/覆盖/重新加载后磁盘锚点推进 → 重拉对齐（changedLines 归零、内容与磁盘一致）
  useEffect(() => {
    if (saveAnchorToken === undefined || saveAnchorToken === saveAnchorRef.current || !target || !path) return
    saveAnchorRef.current = saveAnchorToken
    loadContent(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveAnchorToken, targetKey, path])

  const isMarkdown = useMemo(() => /\.(md|markdown)$/i.test(path), [path])
  const codeLines = content.split('\n')
  const highlightedLines = highlighted?.html.split('\n') ?? null

  if (!target || !provider) return <div className="file-tab-view file-tab-empty">未安装可用的文件 provider</div>
  if (error) return <div className="file-tab-view file-tab-error" role="alert">{error}</div>

  if (editing) {
    return (
      <div className="file-tab-view file-tab-edit" data-path={path}>
        <FileCodeEditor
          key={`${targetKey ?? 'unknown'}:${path}`}
          path={path}
          value={content}
          onChange={value => {
            setContent(value)
            setHighlighted(null)
            onContentChange?.(value)
          }}
          onSelectionChange={onSelectionChange}
        />
      </div>
    )
  }

  return (
    <div className="file-tab-view" data-path={path}>
      {isMarkdown ? (
        <div className="file-tab-md">
          <Suspense fallback={<p className="file-tab-hint">加载 Markdown…</p>}>
            <MarkdownRenderer>{content}</MarkdownRenderer>
          </Suspense>
        </div>
      ) : (
        <div className="file-tab-code" data-lang={highlighted?.lang ?? languageFromPath(path)} data-highlighted={highlighted ? 'true' : 'false'}>
          <div className="file-tab-gutter">
            {codeLines.map((_, index) => <div key={index} className="file-tab-gutter-line">{index + 1}</div>)}
          </div>
          <pre className="file-tab-pre">
            {codeLines.map((line, index) => highlightedLines ? (
              <code key={index} className="file-tab-line" data-line={index + 1} data-changed={changedLines.includes(index + 1) ? 'true' : undefined} dangerouslySetInnerHTML={{ __html: sanitizeHtml(highlightedLines[index] || '&nbsp;') }} />
            ) : (
              <code key={index} className="file-tab-line" data-line={index + 1} data-changed={changedLines.includes(index + 1) ? 'true' : undefined}>{line}</code>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
