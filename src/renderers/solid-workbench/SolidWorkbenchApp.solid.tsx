import { ErrorBoundary, For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { buildChatRowDescriptors } from '../../components/chat/chatRowPipeline.ts'
import { buildMessageLookups } from '../../components/chat/messageLookups.ts'
import { prepareMessages } from '../../components/chat/messagePipeline.ts'
import type { Message, RenderMessage } from '../../components/chat/messageTypes.ts'
import { toolInvocationSnapshot, type WorkbenchActivityNode, type WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import { isValidDiffContentInput, isValidLspDiagnosticContentInput, type ContentPart, type LspDiagnosticContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import { diffSnapshotFromPart } from '../../domains/workbench/diffSnapshot.ts'
import type { InteractionRequest } from '../../domains/activity/interaction.ts'
import type { MessageListItem } from '../../domains/workbench/messageListPort.ts'
import { createToolConnectorLayoutPort } from '../../domains/workbench/toolConnectorLayoutPort.ts'
import { AssistantContent, ReasoningBlock, SolidMessageRow } from './chat/MessageRow.solid.tsx'
import { PlainMessageList } from './chat/PlainMessageList.solid.tsx'
import { SolidToolCard } from './chat/ToolCard.solid.tsx'
import { SolidToolConnector } from './chat/ToolConnector.solid.tsx'
import { SolidGenerationFooter } from './chat/GenerationFooter.solid.tsx'
import { SolidInputBar } from './input/InputBar.solid.tsx'
import { SolidAttachWidget, SolidModeWidget, SolidModelWidget, SolidSendWidget } from './input/WorkbenchWidgets.solid.tsx'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { SolidRendererSlotHost } from './chat/RendererSlotHost.solid.tsx'
import { MarkdownContent } from './chat/MarkdownContent.solid.tsx'
import { SolidCodeBlock } from './chat/CodeBlock.solid.tsx'
import { SolidAnsiBlock } from './chat/AnsiBlock.solid.tsx'
import { SolidFileReferenceCard } from './chat/content/FileReference.solid.tsx'
import { SolidMediaBlock } from './chat/content/MediaBlock.solid.tsx'
import { BUILTIN_MEDIA_RESOLVER_OPTIONS } from './mediaAssetAdapter.ts'
import { SolidPlanGoalContent } from './chat/content/PlanGoalContent.solid.tsx'
import type { LifecycleState } from '../../domains/workbench/lifecycle/lifecycleModel.ts'
import { SolidLifecycleCard, SolidSystemErrorCard, SolidSystemNoticeCard } from './chat/LifecycleCard.solid.tsx'
import { SolidToolInvocationCard } from './chat/ToolInvocationCard.solid.tsx'
import { measureToolAnchor } from './chat/domToolConnectorMeasurement.ts'
import { SolidSearchOrLink } from './chat/content/SearchResults.solid.tsx'
import { SolidDiffContent, SolidLspDiagnosticContent } from './chat/content/DiffDiagnosticContent.solid.tsx'
import { SolidLogBlock, SolidProcessActivity, SolidTerminalBlock } from './chat/content/TerminalBlock.solid.tsx'
import { SolidSubagentCard } from './chat/content/SubagentCard.solid.tsx'
import type { RenderCommandPort } from '../../contracts/messageRenderer.ts'

export interface SolidWorkbenchAppProps {
  context: SolidWorkbenchContextValue
}

export function SolidWorkbenchApp(props: SolidWorkbenchAppProps) {
  return (
    <SolidWorkbenchContext.Provider value={props.context}>
      <ErrorBoundary fallback={error => {
        props.context.reportRendererError?.(error)
        return <div class="solid-workbench-error" role="alert">
          Agent 工作台加载失败：{error instanceof Error ? error.message : String(error)}
        </div>
      }}>
        <WorkbenchContent context={props.context} />
      </ErrorBoundary>
    </SolidWorkbenchContext.Provider>
  )
}

function WorkbenchContent(props: SolidWorkbenchAppProps) {
  const snapshot = () => props.context.runtimeSnapshot()
  const appearance = () => props.context.appearanceSnapshot()
  const connectorPort = createToolConnectorLayoutPort()
  const [messageListPort, setMessageListPort] = createSignal<import('../../domains/workbench/messageListPort.ts').MessageListPort>()
  onCleanup(() => connectorPort.destroy())
  const document = () => snapshot().document
  const viewMessages = createMemo<readonly Message[]>(() => {
    const legacy = snapshot().messages
    const projected = document()?.messages
    // Legacy preview fixtures still contain tool rows that A04 represents as
    // activity nodes. Keep those rows until the content cards consume activity
    // slices; all canonical document messages take precedence otherwise.
    if (legacy.some(message => message.role === 'tool')) return legacy
    return projected?.map(toSolidMessage) ?? legacy
  })
  const renderMessages = createMemo(() => prepareMessages([...viewMessages()]))
  const descriptors = createMemo(() => buildChatRowDescriptors(
    renderMessages(),
    buildMessageLookups(viewMessages()),
    undefined,
  ))
  const items = createMemo<readonly MessageListItem[]>(() => descriptors().map(descriptor => ({
    key: descriptor.key,
    descriptor,
  })))
  createEffect(() => messageListPort()?.setItems(items()))

  return (
    <section
      class="solid-agent-workbench"
      data-renderer="solid"
      data-preview={props.context.input().preview ? 'true' : 'false'}
      data-paused={props.context.paused() ? 'true' : 'false'}
      data-session-id={props.context.input().sessionId ?? undefined}
      data-workspace-mode={props.context.input().workspaceMode}
      data-status={snapshot().status}
      style={{ '--right-inset': `${Math.max(0, props.context.input().rightInset ?? 0)}px` }}
      aria-label="Solid Agent Workbench"
    >
      <Show when={snapshot().status === 'error'}>
        <div class="solid-workbench-runtime-error" role="alert">{snapshot().error || '工作台运行时错误'}</div>
      </Show>
      <Show
        when={props.context.input().sessionId}
        fallback={<WorkbenchEmptyState status={snapshot().status} />}
      >
        <div class="chat-view solid-workbench-chat">
          <div class="term">
            <PlainMessageList
              initialItems={items()}
              renderItem={item => <WorkbenchRow
                descriptor={item.descriptor}
                messages={viewMessages()}
                appearance={appearance()}
                connectorPort={connectorPort}
                context={props.context}
              />}
              onPortReady={port => {
                setMessageListPort(() => port)
                port.setItems(items())
              }}
            />
            <Show when={snapshot().streamingThinking}>
              {text => <div class="term-row term-row-reasoning" data-render-type="reasoning">
                <div class="term-reasoning" data-state="running">{text()}</div>
              </div>}
            </Show>
            <WorkbenchDocumentSurface document={document()} context={props.context} commands={props.context.commands} sessionId={props.context.input().sessionId} reducedMotion={props.context.input().reducedMotion ?? false} connectorPort={connectorPort} />
            <Show when={snapshot().streamingText}>
              {text => <div class="term-row term-row-assistant" data-render-type="assistant">
                <AssistantContent text={text()} appearance={appearance()} streaming />
              </div>}
            </Show>
            <SolidGenerationFooter
              running={snapshot().generating}
              tokenCount={snapshot().tokenCount}
              startTime={snapshot().generationStart}
              lastTokenAt={snapshot().lastTokenAt}
              summary={snapshot().summary}
              phase={snapshot().generationPhase}
              thinkingStart={snapshot().thinkingStart}
              activeTaskContent={snapshot().tasks.find(task => task.status === 'in_progress')?.content}
              appearance={appearance().spinner}
              reducedMotion={props.context.input().reducedMotion}
              onStop={props.context.input().preview ? undefined : () => {
                const sessionId = props.context.input().sessionId
                if (sessionId) void props.context.commands.cancel(sessionId)
              }}
            />
          </div>
          <WorkbenchContentSlot
            nodeId={`${props.context.input().sessionId ?? 'none'}:plan`}
            kind="content.plan"
            payload={{ entries: document()?.plan.entries ?? [], goal: document()?.goal.current }}
            context={props.context}
            fallback={<SolidPlanGoalContent payload={{ entries: document()?.plan.entries ?? [], goal: document()?.goal.current }} />}
          />
        </div>
        <Show when={appearance().showPet}>
          <div class="solid-workbench-pet-slot pet-companion" data-fixture="pending">Pet fixture slot</div>
        </Show>
        <Show when={!props.context.input().replayReadonly}>
          <div class="solid-workbench-control-center-slot control-center" data-fixture="widgets">
            <div class="solid-workbench-widget-strip">
              <SolidModelWidget />
              <SolidModeWidget />
              <SolidAttachWidget />
              <SolidSendWidget />
            </div>
            <SolidInputBar
              externalSend={appearance().inputSubmitButtonMode === 'external'}
              externalAttach={appearance().inputSubmitButtonMode === 'external'}
            />
          </div>
        </Show>
        <Show when={props.context.input().replayReadonly}>
          <div class="solid-workbench-replay-overlay" role="status">历史回放 · 只读</div>
        </Show>
      </Show>
    </section>
  )
}

function WorkbenchDocumentSurface(props: {
  document: WorkbenchDocument | undefined
  context: SolidWorkbenchContextValue
  commands: SolidWorkbenchContextValue['commands']
  sessionId: string | null
  reducedMotion: boolean
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
}) {
  return (
    <Show when={props.document}>
      {document => (
        <>
          <Show when={document().timeline.length > 0}>
            <div class="solid-workbench-timeline" aria-label="事件时间线" data-timeline-count={document().timeline.length} />
          </Show>
          <Show when={lifecycleRenderKind(document().lifecycle)}>
            {kind => <WorkbenchContentSlot
              nodeId={`${props.sessionId ?? 'none'}:lifecycle`}
              kind={kind()}
              payload={document().lifecycle}
              context={props.context}
              fallback={<SolidLifecycleCard
                state={document().lifecycle}
                reducedMotion={props.reducedMotion}
                onRetry={props.sessionId && props.context.hostPort?.capabilities.has('retry')
                  ? () => { void props.commands.retry(props.sessionId!) }
                  : undefined}
                onRecover={props.sessionId && props.context.hostPort?.capabilities.has('recovery')
                  ? strategy => { void props.commands.recover(props.sessionId!, strategy) }
                  : undefined}
              />}
            />}
          </Show>
          <For each={document().systemErrors}>{(error, index) => (
            <WorkbenchContentSlot
              nodeId={`${props.sessionId ?? 'none'}:system-error:${error.eventId ?? error.code ?? index()}`}
              kind="system.error"
              payload={error}
              context={props.context}
              fallback={<SolidSystemErrorCard
                error={error}
                reducedMotion={props.reducedMotion}
                onRetry={props.sessionId && props.context.hostPort?.capabilities.has('retry')
                  ? () => { void props.commands.retry(props.sessionId!) }
                  : undefined}
                onRecover={props.sessionId && props.context.hostPort?.capabilities.has('recovery')
                  ? strategy => { void props.commands.recover(props.sessionId!, strategy) }
                  : undefined}
              />}
            />
          )}</For>
          <Show when={document().timeline.some(entry => entry.kind === 'assist')}>
            <div class="solid-workbench-assist" aria-label="辅助建议" role="status">
              <For each={document().timeline.filter(entry => entry.kind === 'assist')}>{entry => (
                <div class="solid-workbench-assist-entry" data-assist-id={entry.id}>{entry.summary || entry.title || '辅助信息'}</div>
              )}</For>
            </div>
          </Show>
          <Show when={document().activities.length > 0}>
            <div class="solid-workbench-activities" aria-label="活动" data-activity-count={document().activities.length}>
              <Index each={document().activities}>{activity => (
                <CanonicalActivitySlot
                  activity={activity()}
                  document={document()}
                  context={props.context}
                  connectorPort={props.connectorPort}
                />
              )}</Index>
            </div>
          </Show>
          <Show when={document().interactions.some(interaction => interaction.status === 'requested')}>
            <div class="solid-workbench-interactions" aria-label="待处理交互">
              <For each={document().interactions.filter(interaction => interaction.status === 'requested')}>{interaction => (
                <div class="solid-workbench-interaction" data-interaction-id={interaction.id}>
                  <span>{interactionPrompt(interaction.request)}</span>
                  <Show when={props.sessionId}>
                    {sessionId => <For each={interactionOptions(interaction.request)}>{option => (
                      <button type="button" onClick={() => void props.commands.respondInteraction(sessionId(), interaction.id, { optionId: option.id })}>
                        {option.label}
                      </button>
                    )}</For>}
                  </Show>
                </div>
              )}</For>
            </div>
          </Show>
          <Show when={document().session.usage !== undefined}>
            <div class="solid-workbench-usage" aria-label="Usage" data-has-usage="true" />
          </Show>
          <Show when={document().session.options.length > 0}>
            <div class="solid-workbench-config" aria-label="会话配置" data-config-count={document().session.options.length} />
          </Show>
          <Show when={document().diagnostics.length > 0}>
            <div class="solid-workbench-diagnostics" aria-label="诊断">
              <For each={document().diagnostics}>{diagnostic => (
                <WorkbenchContentSlot
                  nodeId={`${props.sessionId ?? 'none'}:notice:${diagnostic.eventId}`}
                  kind="system.notice"
                  payload={diagnostic}
                  context={props.context}
                  fallback={<SolidSystemNoticeCard notice={diagnostic} reducedMotion={props.reducedMotion} />}
                />
              )}</For>
            </div>
          </Show>
        </>
      )}
    </Show>
  )
}

function CanonicalActivitySlot(props: {
  activity: WorkbenchActivityNode
  document: WorkbenchDocument
  context: SolidWorkbenchContextValue
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
}) {
  let root: HTMLDivElement | undefined
  let unregisterTool = () => {}
  let observer: MutationObserver | undefined
  const toolSnapshot = () => props.activity.kind === 'tool' ? toolInvocationSnapshot(props.document, props.activity.id) : null
  const kind = () => activityRenderKind(props.activity, props.context)
  const connectorAppearance = () => {
    const host = props.context.appearanceSnapshot()
    const resolved = props.context.hostPort?.appearance.resolve?.({
      // Connector is owned by the C04 generic lifecycle seam even when a
      // specialized tool kind falls back to the generic base Slot.
      kind: 'tool.generic',
      suiteId: props.context.activation?.suite.value.id ?? '',
      slotId: 'builtin.solid.content.base',
    })
    return {
      toolConnectorMode: resolved?.connectorMode === 'none' ? 'none' : host.toolConnectorMode,
      toolConnectorColor: host.toolConnectorColor,
      toolConnectorStyle: typeof resolved?.connectorStyle === 'string' ? resolved.connectorStyle : host.toolConnectorStyle,
      toolConnectorWidth: typeof resolved?.connectorWidth === 'number' ? resolved.connectorWidth : host.toolConnectorWidth,
      toolConnectorOpacity: typeof resolved?.connectorOpacity === 'number' ? resolved.connectorOpacity : host.toolConnectorOpacity,
    }
  }

  createEffect(() => {
    unregisterTool()
    unregisterTool = () => {}
    if (props.activity.kind !== 'tool') return
    const id = props.activity.id
    unregisterTool = props.connectorPort.registerTool(id, () => {
      const head = root?.querySelector<HTMLButtonElement>('.term-tool-head')
      const indicator = root?.querySelector<HTMLSpanElement>('.term-tool-indicator')
      return measureToolAnchor(head ?? undefined, indicator ?? undefined)
    })
  })
  onMount(() => {
    if (typeof MutationObserver === 'undefined' || !root) return
    observer = new MutationObserver(() => props.connectorPort.invalidate('items-changed'))
    observer.observe(root, { childList: true, subtree: true })
  })
  onCleanup(() => {
    observer?.disconnect()
    unregisterTool()
  })

  return <>
    <Show when={toolSnapshot()?.parentToolCallId}>
      {parentId => <SolidToolConnector
        connectorKey={`${parentId()}->${props.activity.id}`}
        fromMessageId={parentId()}
        toMessageId={props.activity.id}
        status={toolConnectorTone(props.activity.status)}
        visualState={normalizeToolVisualState(props.activity.status)}
        appearance={connectorAppearance()}
        layoutPort={props.connectorPort}
      />}
    </Show>
    <div ref={root} class="solid-workbench-activity-slot" data-activity-id={props.activity.id}>
      <WorkbenchContentSlot
        nodeId={props.activity.id}
        kind={kind()}
        payload={toolSnapshot() ?? props.activity}
        context={props.context}
        fallback={toolSnapshot()
          ? <SolidToolInvocationCard snapshot={toolSnapshot()!} appearance={{ ...props.context.appearanceSnapshot() }} renderKind="tool.generic" commands={fallbackRenderCommands(props.context)} />
          : props.activity.semanticKind === 'activity.process'
            ? <SolidProcessActivity activity={props.activity}
                appearance={{ ...props.context.appearanceSnapshot(), reducedMotion: props.context.input().reducedMotion }}
                commands={fallbackRenderCommands(props.context)} />
          : (props.activity.semanticKind === 'activity.subagent' || props.activity.semanticKind === 'activity.delegation' || props.activity.semanticKind === 'activity.team')
            ? <SolidSubagentCard activity={props.activity}
                appearance={{ ...props.context.appearanceSnapshot(), reducedMotion: props.context.input().reducedMotion }}
                commands={fallbackRenderCommands(props.context)} />
          : <div class="solid-workbench-activity" data-activity-id={props.activity.id} data-status={props.activity.status}>
              {props.activity.title || props.activity.kind} · {props.activity.status}
            </div>}
      />
    </div>
  </>
}

function toolConnectorTone(status: string): 'ok' | 'err' | 'run' {
  if (status === 'completed' || status === 'success') return 'ok'
  if (status === 'failed' || status === 'error' || status === 'cancelled') return 'err'
  return 'run'
}

function lifecycleRenderKind(state: LifecycleState): string | undefined {
  if (state.suspended) return 'lifecycle.suspended'
  if (state.retry) return 'lifecycle.retry'
  if (state.rewind) return 'lifecycle.rewind'
  if (state.compact) return 'lifecycle.compact'
  if (state.lastRecovery) return 'lifecycle.recovered'
  return undefined
}

function normalizedInteractionRequest(value: unknown): InteractionRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const request = value as Partial<InteractionRequest>
  return request.surface === 'interaction' && Array.isArray(request.questions) ? request as InteractionRequest : undefined
}

function interactionPrompt(value: unknown): string {
  if (typeof value === 'string') return value
  const request = normalizedInteractionRequest(value)
  return request?.title || request?.questions[0]?.question || '需要你的确认'
}

function interactionOptions(value: unknown): readonly { id: string; label: string }[] {
  const request = normalizedInteractionRequest(value)
  return request?.questions.flatMap(question => question.options.map(option => ({ id: option.id, label: option.label }))) ?? []
}

function toSolidMessage(message: WorkbenchDocument['messages'][number]): Message {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : message.role === 'reasoning' ? 'reasoning' : 'assistant',
    sender: message.source.provider,
    content: message.content,
    time: message.time,
    running: message.running,
    thoughtStartedAt: message.thoughtStartedAtMs,
    thoughtDurationMs: message.thoughtDurationMs,
    redacted: message.redacted,
    redactedReason: message.redactedReason,
    semanticParts: message.parts,
  } as Message & { semanticParts: readonly ContentPart[] }
}

function WorkbenchEmptyState(props: { status: string }) {
  return (
    <div class="solid-workbench-empty" data-status={props.status}>
      <strong>Pylon</strong>
      <span>{props.status === 'loading' ? '正在加载会话…' : '选择或创建一个 Session'}</span>
    </div>
  )
}

function WorkbenchRow(props: {
  descriptor: MessageListItem['descriptor']
  messages: readonly Message[]
  appearance: SolidWorkbenchContextValue['appearanceSnapshot'] extends () => infer T ? T : never
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
  context: SolidWorkbenchContextValue
}) {
  const current = () => props.descriptor.renderMessage
  const previousTool = () => {
    if (!props.descriptor.showConnector) return undefined
    const index = props.messages.findIndex(message => message.id === current().message.id)
    return index > 0 ? props.messages[index - 1] : undefined
  }
  const visualState = () => normalizeToolVisualState(props.descriptor.toolVisualState)
  const connectorVisualState = () => normalizeToolVisualState(props.descriptor.connectorVisualState)
  // message.* Slots own row framing. Reasoning is a content.* contract and must
  // stay inside the reasoning row, where WorkbenchMessageContent supplies its
  // normalized payload (text/state/duration or redaction reason).
  const messageFrameKind = () => current().message.role === 'user' ? 'message.user'
    : current().message.role === 'assistant' ? 'message.assistant'
      : undefined
  const slotCandidates = () => {
    const kind = messageFrameKind()
    return kind
      ? (props.context.activation?.slots.get(kind) ?? []).filter(entry => entry.value.kinds.includes(kind))
      : []
  }
  const renderDefaultMessage = () => <SolidMessageRow
    renderMessage={current()}
    appearance={props.appearance}
    highlighted={props.descriptor.isSearchMatch}
    semanticContent={<WorkbenchMessageContent
      renderMessage={current()}
      context={props.context}
    />}
  />

  return (
    <>
      <Show when={props.descriptor.showConnector && previousTool()}>
        {previous => <SolidToolConnector
          connectorKey={`${previous().id}->${current().message.id}`}
          fromMessageId={previous().id}
          toMessageId={current().message.id}
          status={props.descriptor.connectorStatus ?? 'run'}
          visualState={connectorVisualState()}
          appearance={props.appearance}
          layoutPort={props.connectorPort}
        />}
      </Show>
      <Show
        when={current().type === 'tool_call' || current().type === 'tool_result'}
        fallback={<Show when={slotCandidates().length > 0} fallback={renderDefaultMessage()}>
          <SolidRendererSlotHost
            candidates={slotCandidates()}
            node={{ nodeId: current().message.id, kind: messageFrameKind() ?? 'content.unknown', revision: props.context.runtimeSnapshot().revision, payload: current() }}
            context={props.context}
            fallback={renderDefaultMessage()}
          />
        </Show>}
      >
        <div class="term-row term-row-tool" data-render-type={current().type}>
          <SolidToolCard
            message={current().message}
            visualState={visualState()}
            appearance={props.appearance}
            messageId={current().message.id}
            layoutPort={props.connectorPort}
          />
        </div>
      </Show>
    </>
  )
}

function WorkbenchMessageContent(props: {
  renderMessage: RenderMessage
  context: SolidWorkbenchContextValue
}) {
  const message = () => props.renderMessage.message
  const parts = () => {
    const canonical = (message() as Message & { semanticParts?: readonly ContentPart[] }).semanticParts
    if (canonical && canonical.length > 0) return canonical
    return [{ kind: 'markdown', text: message().content }] as const satisfies readonly ContentPart[]
  }
  if (props.renderMessage.type === 'reasoning') {
    const redacted = message().redacted === true
    const kind = redacted ? 'content.redacted-reasoning' : 'content.reasoning'
    const payload = redacted
      ? { reason: message().redactedReason ?? 'provider_redacted' }
      : {
          text: message().content,
          state: message().running ? 'running' : message().content.trim() ? 'complete' : 'missing',
          ...(message().thoughtDurationMs !== undefined ? { durationMs: message().thoughtDurationMs } : {}),
        }
    return <WorkbenchContentSlot
      nodeId={`${message().id}:reasoning`} kind={kind} payload={payload}
      context={props.context}
      fallback={<ReasoningBlock
        text={message().content} running={message().running === true}
        startedAt={message().thoughtStartedAt} durationMs={message().thoughtDurationMs}
        redacted={redacted} redactedReason={message().redactedReason}
      />}
    />
  }
  const inline = props.renderMessage.type === 'user'
  return <For each={parts()}>{(part, index) => (
    <WorkbenchContentSlot
      nodeId={`${message().id}:part:${index()}`}
      kind={contentRenderKind(part)}
      payload={part}
      context={props.context}
      fallback={renderBuiltinContentPart(part, inline, props.context)}
    />
  )}</For>
}

function WorkbenchContentSlot(props: {
  nodeId: string
  kind: string
  payload: unknown
  context: SolidWorkbenchContextValue
  fallback: import('solid-js').JSX.Element
}) {
  const candidates = () => (props.context.activation?.slots.get(props.kind) ?? [])
    .filter(entry => entry.value.kinds.includes(props.kind))
  const hasCandidate = () => {
    if (candidates().length > 0) return true
    const activation = props.context.activation
    if (!activation) return false
    const visited = new Set<string>([props.kind])
    let fallbackKind = activation.kinds.get(props.kind)?.value.fallbackKind
    while (fallbackKind && !visited.has(fallbackKind)) {
      visited.add(fallbackKind)
      if ((activation.slots.get(fallbackKind) ?? []).some(entry => entry.value.kinds.includes(fallbackKind!))) return true
      fallbackKind = activation.kinds.get(fallbackKind)?.value.fallbackKind
    }
    return false
  }
  return <Show when={hasCandidate()} fallback={props.fallback}>
    <SolidRendererSlotHost
      candidates={candidates()}
      node={{ nodeId: props.nodeId, kind: props.kind, revision: props.context.runtimeSnapshot().revision, payload: props.payload }}
      context={props.context}
      fallback={props.fallback}
    />
  </Show>
}

function activityRenderKind(activity: WorkbenchActivityNode, context: SolidWorkbenchContextValue): string {
  if (activity.kind !== 'tool') return activity.semanticKind ?? 'activity.generic'
  const semanticKind = activity.semanticKind
  return semanticKind && context.activation?.kinds.has(semanticKind) ? semanticKind : 'tool.generic'
}

function contentRenderKind(part: ContentPart): string {
  if (part.kind === 'unknown') return 'content.unknown'
  if (part.kind === 'diagnostic-lsp') return 'diagnostic.lsp'
  return part.kind.includes('.') ? part.kind : `content.${part.kind}`
}

function renderBuiltinContentPart(part: ContentPart, inline: boolean, context: SolidWorkbenchContextValue) {
  if (part.kind === 'text' || part.kind === 'markdown') return <MarkdownContent text={part.text} inline={inline} />
  if (part.kind === 'code') return <SolidCodeBlock code={part.text} language={part.language} />
  if (part.kind === 'ansi') return <SolidAnsiBlock text={part.text} reducedMotion={context.input().reducedMotion} />
  if (part.kind === 'file-reference' || part.kind === 'file-selection' || part.kind === 'document' || part.kind === 'resource') {
    const host = context.hostPort
    const sessionId = context.input().sessionId
    return <SolidFileReferenceCard part={part} actions={{
      canOpen: Boolean(sessionId && host?.capabilities.has('resourceOpen')),
      canReveal: Boolean(sessionId && host?.capabilities.has('resourceReveal')),
      canCopy: Boolean(sessionId && host?.capabilities.has('clipboardWrite')),
      open: target => { if (host && sessionId) void host.commands.openResource(sessionId, target) },
      reveal: target => { if (host && sessionId) void host.commands.revealResource(sessionId, target) },
      copyPath: path => { if (host && sessionId) void host.commands.copy(sessionId, path) },
    }} />
  }
  if (part.kind === 'image' || part.kind === 'audio' || part.kind === 'video') {
    const host = context.hostPort
    const sessionId = context.input().sessionId
    const canOpenExternal = Boolean(sessionId && host?.capabilities.has('resourceOpen'))
    return <SolidMediaBlock
      part={part}
      resolverOptions={BUILTIN_MEDIA_RESOLVER_OPTIONS}
      onOpenExternal={canOpenExternal && host && sessionId
        ? url => { void host.commands.openResource(sessionId, { uri: url }) }
        : undefined}
      onDownload={canOpenExternal && host && sessionId
        ? mediaPart => { void host.commands.openResource(sessionId, { ...mediaPart, disposition: 'download' }) }
        : undefined}
    />
  }
  if (part.kind === 'search-result' || part.kind === 'link') {
    const commands = fallbackRenderCommands(context)
    return <SolidSearchOrLink part={part} actions={{
      open: commands.canExecute?.('resource.open') ? url => { void commands.execute({ type: 'resource.open', payload: { uri: url } }) } : undefined,
      copy: commands.canExecute?.('clipboard.write') ? text => { void commands.execute({ type: 'clipboard.write', payload: { text } }) } : undefined,
    }} appearance={{ reducedMotion: context.input().reducedMotion }} />
  }
  if (part.kind === 'diff') {
    const snapshot = isValidDiffContentInput(part) ? diffSnapshotFromPart(part) : null
    return snapshot
      ? <SolidDiffContent snapshot={snapshot} nodeId={`fallback:${snapshot.path ?? snapshot.oldPath ?? 'diff'}`}
          appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion }}
          commands={fallbackRenderCommands(context)} />
      : <pre class="solid-content-unknown" data-content-kind="diff">Invalid content.diff payload</pre>
  }
  if (part.kind === 'diagnostic-lsp') {
    return isValidLspDiagnosticContentInput(part)
      ? <SolidLspDiagnosticContent diagnostic={part as LspDiagnosticContentPart}
          appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion }}
          commands={fallbackRenderCommands(context)} />
      : <pre class="solid-content-unknown" data-content-kind="diagnostic-lsp">Invalid diagnostic.lsp payload</pre>
  }
  if (part.kind === 'terminal') {
    const commands = fallbackRenderCommands(context)
    return <SolidTerminalBlock part={part} appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion }} actions={{
      copy: commands.canExecute?.('clipboard.write')
        ? text => { void commands.execute({ type: 'clipboard.write', payload: { text } }) }
        : undefined,
    }} />
  }
  if (part.kind === 'log') {
    return <SolidLogBlock part={part} appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion }} />
  }
  const summary = part.kind === 'unknown' ? part.summary : `Unsupported content kind: ${part.kind}`
  return <pre class="solid-content-unknown" data-content-kind={part.kind}>{summary}</pre>
}

function fallbackRenderCommands(context: SolidWorkbenchContextValue): RenderCommandPort {
  const sessionId = context.input().sessionId
  const capabilities = context.hostPort?.capabilities
  return {
    canExecute: type => Boolean(sessionId && (
      type === 'resource.open' ? capabilities?.has('resourceOpen')
        : type === 'clipboard.write' ? capabilities?.has('clipboardWrite')
          : false
    )),
    execute: command => {
      if (!sessionId) return
      if (command.type === 'resource.open' && command.payload && typeof command.payload === 'object') {
        void context.commands.openResource(sessionId, command.payload)
      } else if (command.type === 'clipboard.write' && command.payload && typeof command.payload === 'object') {
        const text = (command.payload as { text?: unknown }).text
        if (typeof text === 'string') void context.commands.copy(sessionId, text)
      }
    },
  }
}

function normalizeToolVisualState(value: string | undefined) {
  switch (value) {
    case 'queued':
    case 'waiting':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'unknown':
      return value
    default:
      return undefined
  }
}

export function previewRenderMessages(messages: readonly Message[]): readonly RenderMessage[] {
  return prepareMessages([...messages])
}
