import { useState, useSyncExternalStore } from 'react'
import type {
  ContentPart,
  DiffContentPart,
  ImageContentPart,
  LinkContentPart,
  LogContentPart,
  LspDiagnosticContentPart,
  SearchResultContentPart,
  TextRange,
  TerminalContentPart,
  UnknownContentPart,
} from '../../domains/workbench/content/contentPartSchema.ts'
import { stripAnsiControlSequences } from '../../domains/rendererContent/textContentContracts.ts'
import { isValidMediaContentInput } from '../../domains/workbench/content/mediaContentValidation.ts'
import {
  fileContentLastSegment,
  formatFileSelectionRange,
  isBinaryFileContent,
} from '../../domains/rendererContent/fileContentPresentation.ts'
import type { WorkbenchDocumentReader } from '../../renderers/solid-workbench/workbenchHostPort.ts'
import { plainGoalSummary, readablePlanLines } from '../../domains/workbench/plan/goalModel.ts'
import {
  plainLifecycleSummary,
  readableLifecycleLines,
  type NormalizedError,
} from '../../domains/workbench/lifecycle/lifecycleModel.ts'
import { toolInvocationSnapshot, type ToolInvocationSnapshot, type WorkbenchActivityNode } from '../../domains/workbench/workbenchProjector.ts'
import { normalizeToolStatus, toolStatePresentation } from '../../domains/tool/status.ts'

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
  onRetryMessage?(): void
  onRecoverSession?(strategy: 'reload-plugin' | 'reimport'): void
  onRespondInteraction?(interactionId: string, response: unknown, options?: { expectedRevision?: number }): void | Promise<unknown>
  onOpenInteractionUrl?(url: string): void
  onCopyInteractionUrl?(url: string): void
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
      {(plainLifecycleSummary(document?.lifecycle ?? { history: [] }) || (document?.lifecycle.history.length ?? 0) > 0) && <section
        aria-label="生命周期 fallback" className="react-workbench-fatal-lifecycle">
        <strong>生命周期</strong>
        {plainLifecycleSummary(document!.lifecycle) && <p>{plainLifecycleSummary(document!.lifecycle)}</p>}
        <ol>{readableLifecycleLines(document!.lifecycle.history).map((line, index) => <li key={index}>{line}</li>)}</ol>
      </section>}
      {document?.systemErrors.map((error, index) => <ReactFallbackSystemError
        key={`${error.eventId ?? error.code ?? index}`}
        error={error}
        onRetry={props.onRetryMessage}
        onRecover={props.onRecoverSession}
      />)}
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
      {document?.activities.filter(activity => activity.kind === 'tool').map(activity => {
        const snapshot = toolInvocationSnapshot(document, activity.id)
        return snapshot && <ReactFallbackTool key={snapshot.id} snapshot={snapshot} />
      })}

      {document?.activities.filter(activity => activity.kind === 'activity').map(activity =>
        activity.activityKind === 'process' || activity.semanticKind === 'activity.process'
          ? <ReactFallbackProcessActivity key={activity.id} activity={activity} />
          : <ReactFallbackSubagentActivity key={activity.id} activity={activity} />
      )}
      <section className="react-workbench-fatal-interactions" aria-label="交互 fallback">
        {document?.interactions.map(interaction => <ReactFallbackInteraction key={interaction.id}
          interaction={interaction} onRespond={props.onRespondInteraction}
          onOpenUrl={props.onOpenInteractionUrl} onCopyUrl={props.onCopyInteractionUrl} />)}
      </section>
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

function fallbackInteractionRequest(value: unknown): {
  kind?: string
  url?: string
  urlRedacted?: boolean
  stateSummary?: string
  title?: string
  reason?: string
  scope?: string
  command?: string
  path?: string
  questions: Array<{
    id: string; question: string; options: Array<{ id: string; label: string }>
    allowMultiple: boolean; allowFreeform: boolean; placeholder?: string
  }>
} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const request = value as Record<string, unknown>
  if (request.surface !== 'interaction' || !Array.isArray(request.questions)) return undefined
  type ParsedQuestion = {
    id: string; question: string; options: Array<{ id: string; label: string }>
    allowMultiple: boolean; allowFreeform: boolean; placeholder?: string
  }
  const questions = request.questions.flatMap((item, questionIndex): ParsedQuestion[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const question = item as Record<string, unknown>
    if (typeof question.question !== 'string' || !Array.isArray(question.options)) return []
    return [{
      id: typeof question.id === 'string' ? question.id : `question-${questionIndex + 1}`,
      question: question.question,
      allowMultiple: question.allowMultiple === true,
      allowFreeform: question.allowFreeform === true,
      placeholder: typeof question.placeholder === 'string' ? question.placeholder : undefined,
      options: question.options.flatMap(optionValue => {
        if (!optionValue || typeof optionValue !== 'object' || Array.isArray(optionValue)) return []
        const option = optionValue as Record<string, unknown>
        return typeof option.id === 'string' && typeof option.label === 'string'
          ? [{ id: option.id, label: option.label }]
          : []
      }),
    }]
  })
  return {
    kind: typeof request.kind === 'string' ? request.kind : undefined,
    url: typeof request.url === 'string' && (/^https:\/\//i.test(request.url) || /^http:\/\/localhost(?:[:/]|$)/i.test(request.url))
      ? request.url : undefined,
    urlRedacted: request.urlRedacted === true || (typeof request.url === 'string'
      && !/^https:\/\//i.test(request.url) && !/^http:\/\/localhost(?:[:/]|$)/i.test(request.url)),
    stateSummary: typeof request.stateSummary === 'string' ? request.stateSummary : undefined,
    title: typeof request.title === 'string' ? request.title : undefined,
    reason: typeof request.reason === 'string' ? request.reason : undefined,
    scope: typeof request.scope === 'string' ? request.scope : undefined,
    command: typeof request.command === 'string' ? request.command : undefined,
    path: typeof request.path === 'string' ? request.path : undefined,
    questions,
  }
}

function ReactFallbackInteraction(props: {
  interaction: NonNullable<ReturnType<WorkbenchDocumentReader['getSnapshot']>>['interactions'][number]
  onRespond?: (interactionId: string, response: unknown, options?: { expectedRevision?: number }) => void | Promise<unknown>
  onOpenUrl?: (url: string) => void
  onCopyUrl?: (url: string) => void
}) {
  const request = fallbackInteractionRequest(props.interaction.request)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [freeform, setFreeform] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string>()
  const formMode = Boolean(request && (request.questions.length > 1
    || request.questions.some(question => question.allowMultiple || question.allowFreeform)))
  const secretMode = request?.kind === 'secret'
  const select = (questionId: string, optionId: string, multiple: boolean) => setSelected(current => {
    const previous = current[questionId] ?? []
    const values = multiple
      ? previous.includes(optionId) ? previous.filter(value => value !== optionId) : [...previous, optionId]
      : [optionId]
    return { ...current, [questionId]: values }
  })
  const respond = async (response: unknown) => {
    if (!props.onRespond || submitting) return
    setSubmitting(true)
    setSubmitError(undefined)
    try {
      await props.onRespond(props.interaction.id, response, { expectedRevision: props.interaction.sequence })
    } catch (error) {
      setSubmitError(secretMode ? '凭据提交失败，请重试' : error instanceof Error ? error.message : '交互提交失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }
  const submit = () => {
    if (!request || !props.onRespond || submitting) return
    const values = Object.fromEntries(request.questions.flatMap(question => {
      const optionIds = selected[question.id] ?? []
      const text = freeform[question.id]?.trim()
      const answers = text ? [...optionIds, text] : optionIds
      return answers.length === 0 ? [] : [[question.id, question.allowMultiple || answers.length > 1 ? answers : answers[0]!]]
    }))
    if (Object.keys(values).length > 0) {
      if (secretMode) setFreeform({})
      void respond(secretMode && request.questions.length === 1
        ? { value: values[request.questions[0]!.id] }
        : { values })
    }
  }
  return <div data-react-interaction-status={props.interaction.status}>
    <strong>{request?.title || request?.questions[0]?.question || props.interaction.id}</strong>
    <span>{props.interaction.status}</span>
    {request?.reason && <span>原因：{request.reason}</span>}
    {request?.scope && <span>范围：{request.scope}</span>}
    {request?.command && <code>{request.command}</code>}
    {request?.path && <code>{request.path}</code>}
    {request?.kind === 'oauth' && <div>
      {request.stateSummary && <span>{request.stateSummary}</span>}
      {request.url ? <>
        <code>{request.url}</code>
        {props.onOpenUrl && <button type="button" onClick={() => props.onOpenUrl?.(request.url!)}>打开授权页</button>}
        {props.onCopyUrl && <button type="button" onClick={() => props.onCopyUrl?.(request.url!)}>复制授权链接</button>}
      </> : request.urlRedacted ? <span>链接已隐藏</span> : null}
    </div>}
    {props.interaction.status === 'requested' && request && (formMode
      ? <form onSubmit={event => { event.preventDefault(); submit() }}>
        {request.questions.map(question => <fieldset key={question.id}>
          <legend>{question.question}</legend>
          {question.options.map(option => <label key={option.id}>
            <input type={question.allowMultiple ? 'checkbox' : 'radio'}
              name={`fallback-${props.interaction.id}-${question.id}`} value={option.id}
              checked={(selected[question.id] ?? []).includes(option.id)} disabled={!props.onRespond}
              onChange={() => select(question.id, option.id, question.allowMultiple)} />
            {option.label}
          </label>)}
          {question.allowFreeform && <input type={secretMode ? 'password' : 'text'}
            autoComplete={secretMode ? 'off' : undefined}
            placeholder={question.placeholder ?? (secretMode ? question.question : '补充回答')}
            value={freeform[question.id] ?? ''} disabled={!props.onRespond}
            onChange={event => {
              const value = event.currentTarget.value
              setFreeform(current => ({ ...current, [question.id]: value }))
            }} />}
        </fieldset>)}
        <button type="submit" disabled={!props.onRespond || submitting}>{secretMode ? '提交凭据' : '提交回答'}</button>
      </form>
      : request.questions.flatMap(question => question.options).map(option => (
        <button key={option.id} type="button" disabled={!props.onRespond || submitting}
          onClick={() => { void respond({ optionId: option.id }) }}>
          {option.label}
        </button>
      )))}
    {submitError && <span role="alert" aria-label="交互提交失败">{submitError}</span>}
    {!secretMode && props.interaction.response !== undefined && <code>{JSON.stringify(props.interaction.response)}</code>}
    {props.interaction.reason && <span>{props.interaction.reason}</span>}
  </div>
}

function ReactFallbackSubagentActivity({ activity }: { activity: WorkbenchActivityNode }) {
  const isWorkflow = activity.activityKind === 'background-task'
    || activity.activityKind === 'workflow' || activity.activityKind === 'workflow-phase' || activity.activityKind === 'workflow-agent'
  const activityLabel = isWorkflow ? '工作流' : '子代理'
  const output = activity.output ?? (Array.isArray(activity.parts)
    ? activity.parts.filter((part): part is ContentPart => Boolean(part && typeof part === 'object'
      && !Array.isArray(part) && typeof (part as { kind?: unknown }).kind === 'string'))
    : [])
  const resultSummary = activity.result && typeof activity.result === 'object' && !Array.isArray(activity.result)
    && typeof (activity.result as { summary?: unknown }).summary === 'string'
    ? (activity.result as { summary: string }).summary : undefined
  return <section role="status" className="react-workbench-fatal-activity"
    data-react-activity-kind={activity.semanticKind ?? activity.activityKind ?? 'unknown'}
    aria-label={`${activityLabel} fallback：${activity.title || activity.id}，${activity.status}`}>
    <strong>{activity.title || activity.id}</strong>
    <span>{activity.status}{activity.depth !== undefined ? ` · depth ${activity.depth}` : ''}
      {activity.parentId ? ` · parent ${activity.parentId}` : ''}</span>
    {activity.goal && <span>目标：{activity.goal}</span>}
    {activity.description && <span>{activity.description}</span>}
    {activity.progress !== undefined && <pre>{fallbackJson(activity.progress)}</pre>}
    {(activity.killed === true || activity.timeout === true) && <small>{[
      activity.killed === true ? '已终止' : undefined,
      activity.timeout === true ? '超时' : undefined,
    ].filter(Boolean).join(' · ')}</small>}
    {resultSummary && <p>{resultSummary}</p>}
    {output.map((part, index) => <ReactFallbackContentPart key={`${activity.id}:output:${index}`} part={part} />)}
    {activity.usage !== undefined && <pre aria-label="子代理用量">{fallbackJson(activity.usage)}</pre>}
    {activity.metrics !== undefined && <pre aria-label="子代理指标">{fallbackJson(activity.metrics)}</pre>}
    {activity.files !== undefined && <pre aria-label="子代理文件">{fallbackJson(activity.files)}</pre>}
    {activity.execution !== undefined && <pre aria-label="子代理执行元数据">{fallbackJson(activity.execution)}</pre>}
    {activity.error && <span role="alert">{activity.error.userSummary}</span>}
    {activity.reason && <small>{activity.reason}</small>}
    {activity.provenance && <small>来源：{[
      activity.provenance.origin, activity.provenance.trust, activity.provenance.orderConfidence,
    ].filter(Boolean).join(' · ')}</small>}
    {activity.provenance?.synthetic && <small>合成生命周期：{activity.provenance.synthetic.reason}</small>}
  </section>
}

function ReactFallbackProcessActivity({ activity }: { activity: WorkbenchActivityNode }) {
  const parts = Array.isArray(activity.parts)
    ? activity.parts.filter((part): part is ContentPart => Boolean(part && typeof part === 'object'
      && !Array.isArray(part) && typeof (part as { kind?: unknown }).kind === 'string'))
    : []
  const title = activity.title || activity.id
  return <section role="status" className="react-workbench-fatal-activity react-workbench-fatal-process"
    data-react-activity-kind="activity.process"
    aria-label={`进程 fallback：${title}，${activity.status}`}>
    <strong>{title}</strong>
    <span>{activity.status}</span>
    {(activity.processId || activity.sessionId) && <small>{[activity.processId, activity.sessionId].filter(Boolean).join(' · ')}</small>}
    {activity.progress !== undefined && <pre>{fallbackJson(activity.progress)}</pre>}
    {parts.map((part, index) => <ReactFallbackContentPart key={`${activity.id}:${index}`} part={part} />)}
    {activity.error && <span role="alert">{activity.error.userSummary}</span>}
    {activity.reason && <small>{activity.reason}</small>}
    {activity.provenance?.synthetic && <small>合成生命周期：{activity.provenance.synthetic.reason}</small>}
  </section>
}

function ReactFallbackTool({ snapshot }: { snapshot: ToolInvocationSnapshot }) {
  const displayName = snapshot.title || snapshot.canonicalName || snapshot.name || '未知工具'
  const presentation = toolStatePresentation(normalizeToolStatus(snapshot.status ?? snapshot.result?.status), Boolean(snapshot.result))
  const progress = fallbackToolProgress(snapshot.progress)
  const duration = fallbackToolDuration(snapshot.result?.durationMs)
  const parts = Array.isArray(snapshot.result?.parts)
    ? snapshot.result.parts.filter((part): part is ContentPart => Boolean(part && typeof part === 'object' && !Array.isArray(part) && typeof (part as { kind?: unknown }).kind === 'string'))
    : []
  return <section role="status" aria-label={`工具 fallback：${displayName}，${presentation.label}`}
    className="react-workbench-fatal-tool" data-tool-state={presentation.state}>
    <strong>{displayName}</strong>
    {snapshot.name && snapshot.name !== displayName && <span>{snapshot.name}</span>}
    <span>{presentation.label}{duration && ` · ${duration}`}</span>
    {snapshot.input !== undefined && <><span>输入</span><pre>{fallbackJson(snapshot.input)}</pre></>}
    {progress && <><span>进度</span><pre>{progress}</pre></>}
    {parts.length > 0 && <section aria-label="工具输出 fallback">
      <span>输出</span>
      {parts.map((part, index) => 'text' in part && typeof part.text === 'string'
        ? <pre key={index}>{part.text}</pre>
        : <ReactFallbackContentPart key={index} part={part} />)}
    </section>}
    {snapshot.result?.error && <section role="alert">
      <span>错误</span><pre>{snapshot.result.error.userSummary}</pre>
      {snapshot.result.error.code && <small>code: {snapshot.result.error.code}</small>}
      {snapshot.result.error.technicalMessage && snapshot.result.error.technicalMessage !== snapshot.result.error.userSummary
        && <details><summary>技术细节</summary><pre>{snapshot.result.error.technicalMessage}</pre></details>}
    </section>}
  </section>
}

function fallbackToolProgress(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value === undefined ? '' : fallbackJson(value)
  const progress = value as Record<string, unknown>
  if (typeof progress.completed === 'number' && typeof progress.total === 'number') {
    const suffix = typeof progress.message === 'string' && progress.message ? ` · ${progress.message}` : ''
    return `${progress.completed} / ${progress.total}${suffix}`
  }
  return fallbackJson(value)
}

function fallbackToolDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return ''
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
}

function fallbackJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) }
  catch { return '[unavailable]' }
}

function ReactFallbackSystemError(props: {
  error: NormalizedError
  onRetry?: () => void
  onRecover?: (strategy: 'reload-plugin' | 'reimport') => void
}) {
  return <section role="alert" aria-label={`系统错误 fallback：${props.error.userSummary}`} className="react-workbench-fatal-error"
    data-recoverability={props.error.recoverability}>
    <strong>{props.error.userSummary}</strong>
    <details className="react-workbench-error-technical">
      <summary>技术详情</summary>
      <pre>{fallbackErrorDetail(props.error)}</pre>
    </details>
    <div className="renderer-suite-fallback-actions">
      {props.error.recoverability === 'retry' && props.onRetry && <button type="button" onClick={props.onRetry}>重试错误</button>}
      {props.error.recoverability === 'reload-plugin' && props.onRecover && <button type="button" onClick={() => props.onRecover?.('reload-plugin')}>重新加载插件</button>}
      {props.error.recoverability === 'reimport' && props.onRecover && <button type="button" onClick={() => props.onRecover?.('reimport')}>重新导入</button>}
    </div>
  </section>
}

function fallbackErrorDetail(error: NormalizedError): string {
  const lines = [
    error.technicalMessage ?? error.userSummary,
    error.code ? `code: ${error.code}` : undefined,
    error.provider ? `provider: ${error.provider}` : undefined,
    error.pluginId ? `plugin: ${error.pluginId}` : undefined,
    error.rendererSuiteId ? `suite: ${error.rendererSuiteId}` : undefined,
    error.rendererSlotId ? `slot: ${error.rendererSlotId}` : undefined,
    error.eventId ? `event: ${error.eventId}` : undefined,
    error.cause ? `cause: ${fallbackErrorDetail(error.cause)}` : undefined,
    error.metadata ? JSON.stringify(error.metadata, null, 2) : undefined,
  ]
  return lines.filter(Boolean).join('\n')
}

export function ReactFallbackContentPart(props: {
  part: ContentPart
  onOpenMedia?: (part: ImageContentPart) => void
  onDownloadMedia?: (part: ImageContentPart) => void
}) {
  const { part } = props
  if (part.kind === 'text' || part.kind === 'markdown') {
    return <p data-react-content-kind={`content.${part.kind}`} style={{ whiteSpace: 'pre-wrap' }}>{part.text}</p>
  }
  if (part.kind === 'code') {
    return <pre data-react-content-kind="content.code"><code>{part.text}</code></pre>
  }
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
  if (part.kind === 'diff') {
    const value = part as DiffContentPart
    const path = value.path || value.oldPath || '未命名文件'
    const additions = value.additions ?? value.lines?.filter(line => line.kind === 'added').length ?? 0
    const deletions = value.deletions ?? value.lines?.filter(line => line.kind === 'removed').length ?? 0
    return <section data-react-content-kind="content.diff" role="region" aria-label={`Diff fallback：${path}`}>
      <strong>{path}</strong>
      {value.status && <span>{value.status}</span>}
      <small>{additions} additions · {deletions} deletions</small>
      {value.binary ? <p>二进制文件发生变更</p> : <pre>{(value.lines ?? []).map(line => (
        `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}`
      )).join('\n')}</pre>}
      {value.truncated && <small>Diff 已截断</small>}
      {value.unknownFields?.length && <small>unknown: {value.unknownFields.join(', ')}</small>}
      {value.rawPatch !== undefined && <details><summary>Raw 审计信息</summary><pre>{fallbackJson(value.rawPatch)}</pre></details>}
    </section>
  }
  if (part.kind === 'diagnostic-lsp') {
    const value = part as LspDiagnosticContentPart
    const severity = value.severity || 'unknown'
    return <section data-react-content-kind="diagnostic.lsp"
      role={severity === 'error' ? 'alert' : 'status'} aria-label={`LSP ${severity} fallback：${value.message}`}>
      <strong>{value.message}</strong>
      {(value.code || value.source) && <small>{[value.code, value.source].filter(Boolean).join(' · ')}</small>}
      <code>{fallbackLocation(value.path, value.range)}</code>
      {value.related?.length && <ul aria-label="LSP 关联位置 fallback">{value.related.map((item, index) => <li key={index}>
        <span>{item.message}</span><code>{fallbackLocation(item.path, item.range)}</code>
      </li>)}</ul>}
      {value.unknownFields?.length && <small>unknown: {value.unknownFields.join(', ')}</small>}
    </section>
  }
  if (part.kind === 'terminal') {
    const value = part as TerminalContentPart
    const label = value.command || value.processId || value.sessionId || '未命名终端'
    const exit = value.terminatedBy === 'timeout' ? '超时终止'
      : value.terminatedBy === 'killed' ? '已终止 (killed)'
        : value.terminatedBy === 'signal' ? '信号终止'
          : value.exitCode !== undefined ? `exit ${value.exitCode}` : value.status
    return <section data-react-content-kind="content.terminal" role="region" aria-label={`终端 fallback：${label}`}>
      <strong>{value.command || '终端输出'}</strong>
      {(value.processId || value.sessionId) && <small>{[value.processId, value.sessionId].filter(Boolean).join(' · ')}</small>}
      {exit && <span>{exit}</span>}
      <pre>{value.streams.map(entry => `${entry.stream} · ${fallbackTerminalText(entry.text)}`).join('\n')}</pre>
      {value.truncation && <small>
        输出已截断
        {value.truncation.capturedLines !== undefined && `：保留 ${value.truncation.capturedLines} 行`}
        {value.truncation.omittedLines !== undefined && `，省略 ${value.truncation.omittedLines} 行`}
        {value.truncation.omittedBytes !== undefined && `（${value.truncation.omittedBytes} bytes）`}
      </small>}
      {value.error && <span role="alert">{value.error.message}{value.error.code && ` · ${value.error.code}`}</span>}
    </section>
  }
  if (part.kind === 'log') {
    const value = part as LogContentPart
    return <section data-react-content-kind="content.log" role="log" aria-label={`日志 fallback：${value.source || '未命名日志'}`}>
      {value.source && <strong>{value.source}</strong>}
      {value.entries.map((entry, index) => <div key={`${entry.ordinal ?? index}:${entry.level}`}>
        <span>{[entry.originalLevel ?? entry.level, entry.timestamp, entry.text].filter(Boolean).join(' · ')}</span>
        {entry.timestampConfidence === 'synthetic' && <small>时间戳为合成</small>}
      </div>)}
      {value.truncation && <small>
        日志已截断
        {value.truncation.capturedLines !== undefined && `：保留 ${value.truncation.capturedLines} 行`}
        {value.truncation.omittedLines !== undefined && `，省略 ${value.truncation.omittedLines} 行`}
        {value.truncation.omittedBytes !== undefined && `（${value.truncation.omittedBytes} bytes）`}
      </small>}
    </section>
  }
  if (part.kind === 'unknown') {
    const value = part as UnknownContentPart
    return <section data-react-content-kind="content.unknown" aria-label={`未知内容 fallback：${value.originalType}`}>
      <strong>未知内容：{value.originalType}</strong>
      <span>{value.summary}</span>
      <details><summary>Raw 审计信息</summary><pre>{fallbackJson(value.raw)}</pre></details>
      {value.truncation && <small>Raw 已截断，省略 {value.truncation.omittedBytes} bytes</small>}
    </section>
  }
  if (part.kind === 'search-result') {
    const value = part as SearchResultContentPart
    return <section data-react-content-kind="content.search-result"
      aria-label={`搜索结果 fallback：${value.query || '未命名搜索'}`}>
      <strong>{value.query || '搜索结果'}</strong>
      <small>{value.results.length}{value.total !== undefined ? ` / ${value.total}` : ''} 条</small>
      <ol>{value.results.map((entry, index) => <li key={`${entry.source}:${entry.rank ?? index}`}>
        <strong>{entry.title || entry.source}</strong>
        {entry.title && <code>{entry.source}</code>}
        {entry.location?.line !== undefined && <span>L{entry.location.line}</span>}
        {entry.snippet && <p style={{ whiteSpace: 'pre-wrap' }}>{entry.snippet}</p>}
        {entry.score !== undefined && <small>score {entry.score}</small>}
      </li>)}</ol>
      {value.pagingToken && value.total !== undefined && value.total > value.results.length
        && <span>其余 {value.total - value.results.length} 条需分页获取</span>}
    </section>
  }
  if (part.kind === 'link') {
    const value = part as LinkContentPart
    return <section data-react-content-kind="content.link" aria-label={`链接 fallback：${value.title || value.url}`}>
      <strong>{value.title || value.url}</strong>
      <code>{value.url}</code>
      {value.status !== undefined && <small>HTTP {value.status}</small>}
    </section>
  }
  return null
}

function fallbackTerminalText(value: string): string {
  return stripAnsiControlSequences(value).map(span => span.text).join('')
}

function mediaSourceIdentity(part: ImageContentPart): string {
  if (part.sourceKind === 'base64' || /^data:/i.test(part.source)) return `内联 ${part.mimeType ?? part.kind}`
  if (part.sourceKind === 'blob' || /^blob:/i.test(part.source)) return '临时 blob 资源'
  return part.source
}

function fallbackLocation(path: string, range?: TextRange): string {
  if (!range) return path
  const start = `${range.start.line + 1}:${(range.start.character ?? 0) + 1}`
  if (!range.end) return `${path}:${start}`
  return `${path}:${start}–${range.end.line + 1}:${(range.end.character ?? 0) + 1}`
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
