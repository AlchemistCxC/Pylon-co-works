import { useEffect, useMemo, useState, Suspense } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { sanitizeHtml } from '../../components/chat/htmlSanitizer'
import { highlightCode } from '../../components/chat/codeHighlight'
import { MarkdownRenderer } from '../../components/chat/markdownLazy'
import { normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts.ts'
import { languageFromPath } from './fileSheetState.ts'

/**
 * FileTabView — 只读文件视图（W2-04）。
 *
 * read_workspace_text → 代码（highlightCode + sanitizeHtml 安全路径，行号 gutter）或
 * markdown（复用导出 MarkdownRenderer，无 gutter）；truncated 状态可读（内容不完整
 * 明确标注）。消费 8 编辑器 cssVar（F3-D）。
 */
export default function FileTabView({ source, path, onTruncated, onContentReady }: {
  source: string | null
  path: string
  onTruncated: (truncated: boolean) => void
  onContentReady?: (content: string) => void
}) {
  const [content, setContent] = useState('')
  const [highlighted, setHighlighted] = useState<{ html: string; lang: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setContent('')
    setHighlighted(null)
    setError('')
    if (!source || !path) return
    invoke<unknown>('read_workspace_text', { source, relativePath: path }).then(raw => {
      if (cancelled) return
      const text = normalizeWorkspaceText(raw)
      if (!text) { setError('读取失败'); return }
      setContent(text.content)
      onTruncated(text.truncated)
      onContentReady?.(text.content)
      const lang = languageFromPath(path)
      highlightCode(lang, text.content).then(html => {
        if (!cancelled && html) setHighlighted({ html, lang })
      }).catch(() => { /* 高亮失败回退纯文本 */ })
    }).catch(err => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
      reportRuntimeError('读取文件', err)
    })
    return () => { cancelled = true }
  }, [source, path, onTruncated])

  const isMarkdown = useMemo(() => /\.(md|markdown)$/i.test(path), [path])

  if (!source) return <div className="file-tab-view file-tab-empty">未指向会话</div>
  if (error) return <div className="file-tab-view file-tab-error" role="alert">{error}</div>

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
              <code key={index} className="file-tab-line" data-line={index + 1} dangerouslySetInnerHTML={{ __html: sanitizeHtml(line || '&nbsp;') }} />
            ))}
          </pre>
        </div>
      ) : (
        <pre className="file-tab-pre file-tab-plain"><code>{content}</code></pre>
      )}
    </div>
  )
}
