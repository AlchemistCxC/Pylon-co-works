import { useEffect, useMemo, useState, Suspense } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { sanitizeHtml } from '../../components/chat/htmlSanitizer'
import { highlightCode } from '../../components/chat/codeHighlight'
import { MarkdownRenderer } from '../../components/chat/markdownLazy'
import { normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts.ts'
import { changedLineNumbers } from '../../domains/fileDispatch/fileDiff.ts'
import { useWorkspaceStore } from '../../workspaceStore'
import { languageFromPath } from './fileSheetState.ts'

/**
 * FileTabView — 只读文件视图（W2-04）。
 *
 * read_workspace_text → 代码（highlightCode + sanitizeHtml 安全路径，行号 gutter）或
 * markdown（复用导出 MarkdownRenderer，无 gutter）；truncated 状态可读（内容不完整
 * 明确标注）。消费 8 编辑器 cssVar（F3-D）。
 */
export default function FileTabView({ source, path, onTruncated, onContentReady, onSelectionInvalidated }: {
  source: string | null
  path: string
  onTruncated: (truncated: boolean) => void
  onContentReady?: (content: string) => void
  onSelectionInvalidated?: () => void
}) {
  const [content, setContent] = useState('')
  const [highlighted, setHighlighted] = useState<{ html: string; lang: string } | null>(null)
  const [error, setError] = useState('')
  const [changedLines, setChangedLines] = useState<number[]>([])
  // W2-09：版本戳订阅——agent 工具改动该文件时递增，触发 300ms debounce 重拉
  const touchVersion = useWorkspaceStore(s => (source && path) ? s.touchVersions[`${source}:${path}`] : undefined)
  const loadContent = (showChanged: boolean) => {
    if (!source || !path) return
    invoke<unknown>('read_workspace_text', { source, relativePath: path }).then(raw => {
      const text = normalizeWorkspaceText(raw)
      if (!text) return
      setContent(previous => {
        if (showChanged && previous && previous !== text.content) {
          setChangedLines(previous.split('\n').length <= 5000 ? changedLineNumbers(previous, text.content) : [])
          onSelectionInvalidated?.()
        }
        return text.content
      })
      onTruncated(text.truncated)
      onContentReady?.(text.content)
      const lang = languageFromPath(path)
      highlightCode(lang, text.content).then(html => { if (html) setHighlighted({ html, lang }) }).catch(() => {})
    }).catch(err => { setError(err instanceof Error ? err.message : String(err)) })
  }

  useEffect(() => {
    setContent('')
    setHighlighted(null)
    setError('')
    setChangedLines([])
    if (!source || !path) return
    loadContent(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, path])

  // W2-09：版本戳变化 → 300ms debounce 重拉（agent 连续编辑合并为一次）+ 改动行高亮 + 选区失效
  useEffect(() => {
    if (touchVersion === undefined || !source || !path) return
    const timer = window.setTimeout(() => loadContent(true), 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchVersion, source, path])

  const isMarkdown = useMemo(() => /\.(md|markdown)$/i.test(path), [path])

  if (!source) return <div className="file-tab-view file-tab-empty">未指向会话</div>
  if (error) return <div className="file-tab-view file-tab-error" role="alert">{error}</div>

  return (
    <div className="file-tab-view" data-path={path}>
      {isMarkdown ? (
        <div className="file-tab-md">
          <Suspense fallback={<p className="file-tab-hint">加载 Markdown…</p>}>
            <MarkdownRenderer components={{
              // 与 ChatView 同款守卫：文件 markdown 的 asset:/file: 图片不得加载本地文件
              img({ src, alt, ...props }) {
                const allowed = typeof src === 'string' && /^(https?:|data:)/i.test(src)
                if (!allowed) return null
                return <img src={src} alt={alt || ''} {...props} />
              },
            }}>{content}</MarkdownRenderer>
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
