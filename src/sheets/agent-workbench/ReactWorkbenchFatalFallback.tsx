import { useSyncExternalStore } from 'react'
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
          <p style={{ whiteSpace: 'pre-wrap' }}>{message.content}</p>
        </article>)}
      </div>
    </section>
  )
}
