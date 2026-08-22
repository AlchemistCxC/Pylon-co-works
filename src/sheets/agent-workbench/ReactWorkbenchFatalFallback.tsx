import { useSyncExternalStore } from 'react'
import type { ContentPart, ImageContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import { isValidMediaContentInput } from '../../domains/workbench/content/mediaContentValidation.ts'
import {
  fileContentLastSegment,
  formatFileSelectionRange,
  isBinaryFileContent,
} from '../../domains/rendererContent/fileContentPresentation.ts'
import type { WorkbenchDocumentReader } from '../../renderers/solid-workbench/workbenchHostPort.ts'
import { plainGoalSummary, readablePlanLines } from '../../domains/workbench/plan/goalModel.ts'

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
  onOpenMedia?(part: ImageContentPart): void
  onDownloadMedia?(part: ImageContentPart): void
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
      {document && document.plan.entries.length > 0 && <section aria-label="计划 fallback" className="react-workbench-fatal-plan">
        <strong>计划</strong>
        <ol>{readablePlanLines(document.plan.entries).map((line, index) => <li key={`${document.plan.entries[index]?.id ?? index}`}>{line}</li>)}</ol>
      </section>}
      {document?.goal.current && <section role="status" aria-label="目标 fallback" className="react-workbench-fatal-goal">
        <strong>目标</strong>
        <p>{plainGoalSummary(document.goal.current)}</p>
        {document.goal.current.accounting?.timeUsedSeconds !== undefined && <small>
          耗时 {document.goal.current.accounting.timeUsedSeconds} 秒
        </small>}
        {(document.goal.current.metadata || document.goal.current.accounting?.metadata) && <details>
          <summary>未知字段</summary>
          <pre>{JSON.stringify({
            ...document.goal.current.metadata,
            accounting: document.goal.current.accounting?.metadata,
          }, null, 2)}</pre>
        </details>}
      </section>}
      <div className="react-workbench-fatal-history" aria-label="会话历史">
        {document?.messages.map(message => <article key={message.id} data-message-role={message.role}>
          <span>{message.role === 'user' ? 'User' : message.role === 'reasoning' ? 'Reasoning' : 'Assistant'}</span>
          {message.content && <p style={{ whiteSpace: 'pre-wrap' }}>{message.content}</p>}
          {message.parts.map((part, index) => <ReactFallbackContentPart
            key={`${message.id}:${index}`}
            part={part}
            onOpenMedia={props.onOpenMedia}
            onDownloadMedia={props.onDownloadMedia}
          />)}
        </article>)}
      </div>
    </section>
  )
}

function ReactFallbackContentPart(props: {
  part: ContentPart
  onOpenMedia?: (part: ImageContentPart) => void
  onDownloadMedia?: (part: ImageContentPart) => void
}) {
  const { part } = props
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
  if (part.kind === 'image' || part.kind === 'audio' || part.kind === 'video') {
    const value = part as ImageContentPart
    const valid = isValidMediaContentInput(value, value.kind)
    const mediaLabel = value.kind === 'image' ? '图片' : value.kind === 'audio' ? '音频' : '视频'
    const identity = value.alt || value.caption || mediaLabel
    const metadata = mediaMetadata(value)
    return <section data-react-content-kind={`content.${value.kind}`} aria-label={`${mediaLabel} fallback`}>
      <strong>{mediaLabel}</strong>
      {value.alt && <span>{value.alt}</span>}
      {value.caption && value.caption !== value.alt && <span>{value.caption}</span>}
      {valid
        ? <code>{mediaSourceIdentity(value)}</code>
        : <span role="status">媒体来源不可用</span>}
      {metadata && <small>{metadata}</small>}
      {value.transcript && <p style={{ whiteSpace: 'pre-wrap' }}>{value.transcript}</p>}
      <div className="renderer-suite-fallback-actions">
        <button type="button" aria-label={`打开媒体：${identity}`}
          disabled={!valid || !props.onOpenMedia}
          title={!valid ? '媒体来源不可用' : !props.onOpenMedia ? '打开能力未接入' : undefined}
          onClick={() => { if (valid) props.onOpenMedia?.(value) }}>打开</button>
        <button type="button" aria-label={`下载媒体：${identity}`}
          disabled={!valid || !props.onDownloadMedia}
          title={!valid ? '媒体来源不可用' : !props.onDownloadMedia ? '下载能力未接入' : undefined}
          onClick={() => { if (valid) props.onDownloadMedia?.(value) }}>下载</button>
      </div>
    </section>
  }
  return null
}

function mediaSourceIdentity(part: ImageContentPart): string {
  if (part.sourceKind === 'base64' || /^data:/i.test(part.source)) return `内联 ${part.mimeType ?? part.kind}`
  if (part.sourceKind === 'blob' || /^blob:/i.test(part.source)) return '临时 blob 资源'
  return part.source
}

function mediaMetadata(part: ImageContentPart): string {
  const values: string[] = []
  if (part.width !== undefined && part.height !== undefined) values.push(`${part.width}×${part.height}`)
  if (part.durationMs !== undefined) values.push(formatMediaDuration(part.durationMs))
  if (part.mimeType) values.push(part.mimeType)
  return values.join(' · ')
}

function formatMediaDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`
}
