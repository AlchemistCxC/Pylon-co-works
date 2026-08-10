import { useEffect, useMemo, useRef, useState, Suspense } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { sanitizeHtml } from '../../components/chat/htmlSanitizer'
import { highlightCode } from '../../components/chat/codeHighlight'
import { MarkdownRenderer } from '../../components/chat/markdownLazy'
import { createWorkspaceClient } from '../../infrastructure/tauri/workspaceClient'
import { normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts.ts'
import { changedLineNumbers } from '../../domains/fileDispatch/fileDiff.ts'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { useWorkspaceStore } from '../../workspaceStore'
import { languageFromPath } from './fileSheetState.ts'
import { selectionLinesFromTextarea } from './workingDiff.ts'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'

/**
 * FileTabView — 文件视图（W2-04 只读 + I08-A-FE-02 编辑模式）。
 *
 * 只读：read_workspace_text → 代码（highlightCode + sanitizeHtml 安全路径，行号 gutter）或
 * markdown（复用导出 MarkdownRenderer，无 gutter）；truncated 状态可读。
 * 编辑：受控 textarea 承载内容，输入经 onContentChange 上报（不落盘）；选区经
 * onSelectionChange 报 1-based 行号。dirty 感知 touchVersion 重载：编辑中磁盘变化
 * 时若用户有未保存编辑 → onExternalChange 上报冲突（绝不静默覆盖）；无编辑 → 安全
 * 刷新到磁盘。saveAnchorToken 递增（保存成功/覆盖/重新加载后）→ 重拉磁盘对齐锚点。
 */
export default function FileTabView({ source, path, editing, onTruncated, onContentReady, onContentChange, onExternalChange, onSelectionChange, onSelectionInvalidated, saveAnchorToken }: {
  source: string | null
  path: string
  editing?: boolean
  onTruncated: (truncated: boolean) => void
  onContentReady?: (content: string) => void
  onContentChange?: (content: string) => void
  onExternalChange?: () => void
  onSelectionChange?: (selection: DispatchSelection | null) => void
  onSelectionInvalidated?: () => void
  saveAnchorToken?: number
}) {
  const [content, setContent] = useState('')
  const [highlighted, setHighlighted] = useState<{ html: string; lang: string } | null>(null)
  const [error, setError] = useState('')
  const [changedLines, setChangedLines] = useState<number[]>([])
  const requestContext = useRef<SourceRequestContext>({ source: null, generation: 0 })
  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  // I08-A-FE-02：编辑器内容 ref（探针/选区用）+ 磁盘锚点 ref（区分"用户编辑"与"陈旧显示"）
  const contentRef = useRef('')
  const diskRef = useRef<string | null>(null)
  const saveAnchorRef = useRef<number>(0)
  // W2-09：版本戳订阅——agent 工具改动该文件时递增，触发 300ms debounce 重拉
  const touchVersion = useWorkspaceStore(s => (source && path) ? s.touchVersions[`${source}:${path}`] : undefined)

  useEffect(() => { contentRef.current = content }, [content])

  const fetchText = (requestSource: string, requestPath: string): Promise<{ text: string; truncated: boolean } | null> =>
    createWorkspaceClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).readText(requestSource, requestPath).then(raw => {
      const text = normalizeWorkspaceText(raw)
      return text ? { text: text.content, truncated: text.truncated } : null
    })

  const loadContent = (showChanged: boolean) => {
    if (!source || !path) return
    requestContext.current = { source, generation: requestContext.current.generation + 1 }
    const token = beginSourceRequest(requestContext.current, source)
    const requestPath = path
    fetchText(source, path).then(loaded => {
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
      highlightCode(lang, loaded.text).then(html => {
        if (html && isCurrentSourceRequest(requestContext.current, token) && requestPath === path) setHighlighted({ html, lang })
      }).catch(() => {})
    }).catch(err => {
      if (isCurrentSourceRequest(requestContext.current, token) && requestPath === path) setError(err instanceof Error ? err.message : String(err))
    })
  }

  // I08-A-FE-02：编辑中探测磁盘——用户编辑与磁盘一致 → 安全刷新；不一致 → 上报冲突
  const probeDisk = () => {
    if (!source || !path) return
    requestContext.current = { source, generation: requestContext.current.generation + 1 }
    const token = beginSourceRequest(requestContext.current, source)
    const requestPath = path
    fetchText(source, path).then(loaded => {
      if (!loaded || !isCurrentSourceRequest(requestContext.current, token) || requestPath !== path) return
      if (loaded.text === contentRef.current) return
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
    requestContext.current = advanceSourceContext(requestContext.current, source)
    setContent('')
    setHighlighted(null)
    setError('')
    setChangedLines([])
    contentRef.current = ''
    diskRef.current = null
    if (!source || !path) return
    loadContent(false)
    return () => {
      requestContext.current = advanceSourceContext(requestContext.current, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, path])

  // W2-09：版本戳变化 → 300ms debounce；编辑中改走探测（不静默覆盖），只读保持重拉
  useEffect(() => {
    if (touchVersion === undefined || !source || !path) return
    const timer = window.setTimeout(() => {
      if (editing) probeDisk()
      else loadContent(true)
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchVersion, source, path, editing])

  // I08-A-FE-02：保存成功/覆盖/重新加载后磁盘锚点推进 → 重拉对齐（changedLines 归零、内容与磁盘一致）
  useEffect(() => {
    if (saveAnchorToken === undefined || saveAnchorToken === saveAnchorRef.current || !source || !path) return
    saveAnchorRef.current = saveAnchorToken
    loadContent(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveAnchorToken, source, path])

  const reportSelection = () => {
    const textarea = textAreaRef.current
    if (!textarea) return
    onSelectionChange?.(textarea.value ? selectionLinesFromTextarea(textarea) : null)
  }

  const isMarkdown = useMemo(() => /\.(md|markdown)$/i.test(path), [path])

  if (!source) return <div className="file-tab-view file-tab-empty">未指向会话</div>
  if (error) return <div className="file-tab-view file-tab-error" role="alert">{error}</div>

  if (editing) {
    return (
      <div className="file-tab-view file-tab-edit" data-path={path}>
        <textarea
          ref={textAreaRef}
          className="file-edit-textarea"
          value={content}
          onChange={event => {
            const value = event.target.value
            setContent(value)
            onContentChange?.(value)
          }}
          onSelect={reportSelection}
          onKeyUp={reportSelection}
          onClick={reportSelection}
          spellCheck={false}
          aria-label={`编辑 ${path}`}
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
      ) : highlighted ? (
        <div className="file-tab-code" data-lang={highlighted.lang}>
          <div className="file-tab-gutter">
            {highlighted.html.split('\n').map((_, index) => <div key={index} className="file-tab-gutter-line">{index + 1}</div>)}
          </div>
          <pre className="file-tab-pre">
            {highlighted.html.split('\n').map((line, index) => (
              <code key={index} className="file-tab-line" data-line={index + 1} data-changed={changedLines.includes(index + 1) ? 'true' : undefined} dangerouslySetInnerHTML={{ __html: sanitizeHtml(line || '&nbsp;') }} />
            ))}
          </pre>
        </div>
      ) : (
        <pre className="file-tab-pre file-tab-plain"><code>{content}</code></pre>
      )}
    </div>
  )
}
