import { useSyncExternalStore } from 'react'
import type { ContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import {
  fileContentLastSegment,
  formatFileSelectionRange,
  isBinaryFileContent,
} from '../../domains/rendererContent/fileContentPresentation.ts'
import type { WorkbenchDocumentReader } from '../../renderers/solid-workbench/workbenchHostPort.ts'

export interface WorkbenchFatalFailure {
  readonly suiteId: string
  readonly pluginId?: string
  readonly phase: string
  readonly message: string
  readonly retained?: boolean
}

export default function ReactWorkbenchFatalFallback(props: {
  document: WorkbenchDocumentReader
  failure: WorkbenchFatalFailure
  onRetry(): void
  onSelectSuite(): void
  onOpenDiagnostics(): void
}) {
  const document = useSyncExternalStore(
    listener => props.document.subscribe(listener),
    () => props.document.getSnapshot(),
    () => props.document.getSnapshot(),
  )
  return (
    <section className="react-workbench-fatal-fallback" role="alert"
      data-suite-id={props.failure.suiteId} data-failure-phase={props.failure.phase}
      data-document-revision={document?.revision ?? 0} aria-label="React Workbench fatal fallback">
      <header className="renderer-suite-fallback-banner">
        <strong>Solid 工作台已降级</strong>
        <span>{props.failure.suiteId} · {props.failure.phase}</span>
        {props.failure.pluginId && <span>{props.failure.pluginId}</span>}
        <span>{props.failure.message}</span>
        <div className="renderer-suite-fallback-actions">
          <button type="button" onClick={props.onRetry}>重试 Solid</button>
          <button type="button" onClick={props.onSelectSuite}>切换 Suite</button>
          <button type="button" onClick={props.onOpenDiagnostics}>打开诊断</button>
        </div>
      </header>
      <div className="react-workbench-fatal-history" aria-label="会话历史">
        {document?.messages.map(message => <article key={message.id} data-message-role={message.role}>
          <span>{message.role === 'user' ? 'User' : message.role === 'reasoning' ? 'Reasoning' : 'Assistant'}</span>
          {message.content && <p style={{ whiteSpace: 'pre-wrap' }}>{message.content}</p>}
          {message.parts.map((part, index) => <ReactC02ContentPart key={`${message.id}:${index}`} part={part} />)}
        </article>)}
      </div>
    </section>
  )
}

function ReactC02ContentPart({ part }: { part: ContentPart }) {
  if (part.kind === 'file-reference' || part.kind === 'file-selection') {
    const value = part as unknown as {
      path: string; displayName?: string; mime?: string; size?: number; language?: string; previewText?: string
      selection?: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } }
    }
    return <section data-react-content-kind={`content.${part.kind}`} aria-label={part.kind === 'file-selection' ? '文件选择区' : '文件引用'}>
      <strong>{value.displayName || fileContentLastSegment(value.path)}</strong>
      <span>{value.path}</span>
      {part.kind === 'file-selection' && <span>{formatFileSelectionRange(value.selection)}</span>}
      {(value.mime || value.language || value.size !== undefined) && <small>
        {[value.mime, value.language, value.size !== undefined ? `${value.size} B` : undefined].filter(Boolean).join(' · ')}
      </small>}
      {part.kind === 'file-selection' && value.previewText && <pre>{value.previewText}</pre>}
    </section>
  }
  if (part.kind === 'document') {
    const value = part as unknown as { title?: string; path?: string; uri?: string; mimeType?: string; text?: string; hasBlob?: boolean }
    const source = value.path ?? value.uri
    return <section data-react-content-kind="content.document" aria-label="内联文档">
      <strong>{value.title || (source ? fileContentLastSegment(source) : '文档')}</strong>
      {source && <span>{source}</span>}
      {value.mimeType && <small>{value.mimeType}</small>}
      {value.text && <pre>{value.text}</pre>}
      {!value.text && isBinaryFileContent(value) && <span>二进制内容不内联展示</span>}
    </section>
  }
  if (part.kind === 'resource') {
    const value = part as { kind: 'resource'; uri: string; title?: string; mimeType?: string; text?: string; hasBlob?: boolean }
    return <section data-react-content-kind="content.resource" aria-label="外部资源">
      <strong>{value.title || fileContentLastSegment(value.uri)}</strong>
      <span>{value.uri}</span>
      {value.mimeType && <small>{value.mimeType}</small>}
      {value.text && <pre>{value.text}</pre>}
      {!value.text && isBinaryFileContent(value) && <span>二进制内容不内联展示</span>}
    </section>
  }
  return null
}
