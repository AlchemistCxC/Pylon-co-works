import { ErrorBoundary, For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { buildChatRowDescriptors } from '../../components/chat/chatRowPipeline.ts'
import { buildMessageLookups } from '../../components/chat/messageLookups.ts'
import { prepareMessages } from '../../components/chat/messagePipeline.ts'
import type { Message, RenderMessage } from '../../components/chat/messageTypes.ts'
import { selectActivityDisplayOrder, toolInvocationSnapshot, type WorkbenchActivityNode, type WorkbenchDocument, type WorkbenchExtensionNode, type WorkbenchInteraction } from '../../domains/workbench/workbenchProjector.ts'
import { isValidDiffContentInput, isValidHookSurfaceInput, isValidLspDiagnosticContentInput, type ContentPart, type LspDiagnosticContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import { diffSnapshotFromPart } from '../../domains/workbench/diffSnapshot.ts'
import type { MessageListItem } from '../../domains/workbench/messageListPort.ts'
import { MESSAGE_LIST_BOTTOM_THRESHOLD_PX } from '../../domains/workbench/messageViewportState.ts'
import { createToolConnectorLayoutPort } from '../../domains/workbench/toolConnectorLayoutPort.ts'
import { AssistantContent, ReasoningBlock, SolidMessageRow } from './chat/MessageRow.solid.tsx'
import { PlainMessageList } from './chat/PlainMessageList.solid.tsx'
import { SolidToolCard } from './chat/ToolCard.solid.tsx'
import { SolidToolConnector } from './chat/ToolConnector.solid.tsx'
import { SolidGenerationFooter } from './chat/GenerationFooter.solid.tsx'
import { SolidControlCenter } from './input/ControlCenter.solid.tsx'
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
import { SolidWorkflowActivityCard } from './chat/content/WorkflowCard.solid.tsx'
import { SolidInteractionCard } from './chat/content/InteractionCard.solid.tsx'
import { SolidSessionSurfaceCard } from './chat/content/SessionSurfaceCard.solid.tsx'
import { SolidExtensionContentCard } from './chat/content/ExtensionContentCard.solid.tsx'
import type { RenderCommandPort } from '../../contracts/messageRenderer.ts'
import { canExecuteRendererSemanticCommand, executeRendererSemanticCommand } from '../../host/renderer-suite/rendererSemanticCommand.ts'
import { normalizeWorkbenchMountInput } from './workbenchContracts.ts'
import { messageMatchesQuery, searchValuesMatchQuery } from '../../components/chat/messageSearchIndex.ts'
import { createSessionUiSignal } from './adapters/sessionUiSignal.solid.tsx'
import { selectAgentEmptyState } from '../../domains/workbench/agentEmptyState.ts'

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
  const [followBottom, setFollowBottom] = createSignal(true)
  const sessionId = () => props.context.input().sessionId
  const [searchQuery] = createSessionUiSignal(props.context.sessionUi, sessionId, 'search-query', '')
  const [searchIndex, setSearchIndex] = createSessionUiSignal(props.context.sessionUi, sessionId, 'search-index', 0)
  let bottomAnchor: HTMLDivElement | undefined
  let followedSessionId: string | null | undefined
  onCleanup(() => {
    bottomAnchor = undefined
    connectorPort.destroy()
  })
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
  const searchMatches = createMemo(() => {
    if (!searchQuery().trim()) return []
    if (!snapshot().messages.some(message => message.role === 'tool') && document()) {
      return document()!.messages.filter(message => searchValuesMatchQuery([
        message.source.provider,
        message.content,
        message.parts,
      ], searchQuery()))
    }
    return viewMessages().filter(message => messageMatchesQuery(message, searchQuery()))
  })
  const activeSearchMessageId = createMemo(() => searchMatches()[searchIndex()]?.id)
  const descriptors = createMemo(() => buildChatRowDescriptors(
    renderMessages(),
    buildMessageLookups(viewMessages()),
    activeSearchMessageId(),
  ))
  const items = createMemo<readonly MessageListItem[]>(() => descriptors().map(descriptor => ({
    key: descriptor.key,
    descriptor,
  })))
  createEffect(() => messageListPort()?.setItems(items()))
  createEffect(() => {
    const matchCount = searchMatches().length
    const currentIndex = searchIndex()
    const clampedIndex = matchCount === 0 || !Number.isSafeInteger(currentIndex)
      ? 0
      : Math.max(0, Math.min(currentIndex, matchCount - 1))
    if (clampedIndex !== currentIndex) setSearchIndex(clampedIndex)
  })
  createEffect(() => {
    const port = messageListPort()
    const messageId = activeSearchMessageId()
    if (port && messageId) void port.scrollTo({ messageId, align: 'center' })
  })
  createEffect(() => {
    const id = sessionId()
    if (id === followedSessionId) return
    followedSessionId = id
    setFollowBottom(true)
  })
  createEffect(() => {
    sessionId()
    snapshot()
    if (!followBottom()) return
    queueMicrotask(() => bottomAnchor?.scrollIntoView?.({ behavior: 'auto', block: 'end' }))
  })

  const updateBottomFollow = (viewport: HTMLDivElement) => {
    const distance = Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)
    setFollowBottom(distance <= MESSAGE_LIST_BOTTOM_THRESHOLD_PX)
  }

  const resumeBottomFollow = () => {
    setFollowBottom(true)
    bottomAnchor?.scrollIntoView?.({
      behavior: props.context.input().reducedMotion ? 'auto' : 'smooth',
      block: 'end',
    })
  }

  return (
    <section
      class="solid-agent-workbench"
      data-renderer="solid"
      data-preview={props.context.input().preview ? 'true' : 'false'}
      data-paused={props.context.paused() ? 'true' : 'false'}
      data-session-id={props.context.input().sessionId ?? undefined}
      data-workspace-mode={props.context.input().workspaceMode}
      data-status={snapshot().status}
      style={{ '--right-panel-inset': `${Math.max(0, props.context.input().rightInset ?? 0)}px` }}
      aria-label="Solid Agent Workbench"
    >
      <Show when={snapshot().status === 'error'}>
        <div class="solid-workbench-runtime-error" role="alert">{snapshot().error || '工作台运行时错误'}</div>
      </Show>
      <Show
        when={props.context.input().sessionId}
        fallback={<WorkbenchEmptyState
          status={snapshot().status}
          workspaceMode={props.context.input().workspaceMode ?? 'work'}
          context={props.context}
        />}
      >
        <div class="chat-view solid-workbench-chat" onScroll={event => updateBottomFollow(event.currentTarget)}>
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
              tokenCount={canonicalTokenCount(document()?.session.usage, snapshot().tokenCount)}
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
          <div ref={bottomAnchor} class="solid-workbench-bottom-anchor" aria-hidden="true" />
        </div>
        <Show when={!followBottom()}>
          <button type="button" class="scroll-bottom-btn" aria-label="回到底部" title="回到底部" onClick={resumeBottomFollow}>▼</button>
        </Show>
        <Show when={appearance().showPet}>
          <div class="solid-workbench-pet-slot pet-companion" data-fixture="pending">Pet fixture slot</div>
        </Show>
        <Show when={!props.context.input().replayReadonly}>
          <SolidControlCenter />
        </Show>
        <Show when={props.context.input().replayReadonly}>
          <div class="solid-workbench-replay-overlay" role="status">历史回放 · 只读</div>
        </Show>
      </Show>
    </section>
  )
}

function canonicalTokenCount(
  usage: WorkbenchDocument['session']['usage'],
  fallback: number,
): number {
  if (!usage) return fallback
  if (usage.totalTokens !== undefined) return usage.totalTokens

  const known = [
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
  ].filter((value): value is number => value !== undefined)

  return known.length > 0
    ? known.reduce((total, value) => total + value, 0)
    : fallback
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
          <Show when={document().assist?.prediction || document().assist?.queuedCommand}>
            <WorkbenchContentSlot
              nodeId={`${props.sessionId ?? 'none'}:assist:prediction`}
              kind="assist.prediction"
              payload={document().assist}
              context={props.context}
              fallback={<SolidSessionSurfaceCard kind="assist.prediction" payload={document().assist}
                appearance={sessionSurfaceAppearance(props.context, 'assist.prediction')}
                commands={fallbackRenderCommands(props.context)} />}
            />
          </Show>
          <Show when={(document().assist?.files?.length ?? 0) > 0}>
            <WorkbenchContentSlot
              nodeId={`${props.sessionId ?? 'none'}:assist:files`}
              kind="assist.file-suggestions"
              payload={document().assist}
              context={props.context}
              fallback={<SolidSessionSurfaceCard kind="assist.file-suggestions" payload={document().assist}
                appearance={sessionSurfaceAppearance(props.context, 'assist.file-suggestions')}
                commands={fallbackRenderCommands(props.context)} />}
            />
          </Show>
          <Show when={document().activities.length > 0}>
            <div class="solid-workbench-activities" aria-label="活动" data-activity-count={document().activities.length}>
              <Index each={selectActivityDisplayOrder(document())}>{activity => (
                <CanonicalActivitySlot
                  activity={activity()}
                  document={document()}
                  context={props.context}
                  connectorPort={props.connectorPort}
                />
              )}</Index>
            </div>
          </Show>
          <Show when={document().interactions.length > 0}>
            <div class="solid-workbench-interactions" aria-label="交互">
              <For each={document().interactions}>{interaction => (
                <WorkbenchContentSlot
                  nodeId={`${props.sessionId ?? 'none'}:interaction:${interaction.id}`}
                  kind={interactionRenderKind(interaction)}
                  payload={interaction}
                  context={props.context}
                  fallback={<SolidInteractionCard
                    interaction={interaction}
                    appearance={{ ...props.context.appearanceSnapshot(), reducedMotion: props.reducedMotion }}
                    commands={fallbackRenderCommands(props.context)}
                  />}
                />
              )}</For>
            </div>
          </Show>
          <Show when={document().extensions.length > 0}>
            <div class="solid-workbench-extensions" aria-label="扩展事件" data-extension-count={document().extensions.length}>
              <For each={document().extensions}>{extension => (
                <WorkbenchContentSlot
                  nodeId={`${props.sessionId ?? 'none'}:extension:${extension.id}`}
                  kind={extension.kind}
                  payload={extension.payload}
                  context={props.context}
                  fallback={renderExtensionFallback(extension, props.context)}
                />
              )}</For>
            </div>
          </Show>
          <Show when={document().session.usage !== undefined}>
            <div class="solid-workbench-usage" data-has-usage="true">
              <WorkbenchContentSlot
                nodeId={`${props.sessionId ?? 'none'}:session:usage`}
                kind="session.usage"
                payload={document().session.usage}
                context={props.context}
                fallback={<SolidSessionSurfaceCard kind="session.usage" payload={document().session.usage}
                  appearance={sessionSurfaceAppearance(props.context, 'session.usage')}
                  commands={fallbackRenderCommands(props.context)} />}
              />
              <Show when={document().session.usage?.budget}>
                {budget => <WorkbenchContentSlot
                  nodeId={`${props.sessionId ?? 'none'}:session:budget`}
                  kind="session.budget"
                  payload={budget()}
                  context={props.context}
                  fallback={<SolidSessionSurfaceCard kind="session.budget" payload={budget()}
                    appearance={sessionSurfaceAppearance(props.context, 'session.budget')}
                    commands={fallbackRenderCommands(props.context)} />}
                />}
              </Show>
            </div>
          </Show>
          <Show when={(document().session.options?.length ?? 0) > 0}>
            <div class="solid-workbench-config" data-config-count={document().session.options?.length ?? 0}>
              <WorkbenchContentSlot
                nodeId={`${props.sessionId ?? 'none'}:session:config`}
                kind="session.config"
                payload={{ options: document().session.options ?? [] }}
                context={props.context}
                fallback={<SolidSessionSurfaceCard kind="session.config" payload={{ options: document().session.options ?? [] }}
                  appearance={sessionSurfaceAppearance(props.context, 'session.config')}
                  commands={fallbackRenderCommands(props.context)} />}
              />
            </div>
          </Show>
          <Show when={(document().session.commands?.length ?? 0) > 0}>
            <div class="solid-workbench-commands" data-command-count={document().session.commands?.length ?? 0}>
              <WorkbenchContentSlot
                nodeId={`${props.sessionId ?? 'none'}:session:commands`}
                kind="session.commands"
                payload={{ commands: document().session.commands ?? [] }}
                context={props.context}
                fallback={<SolidSessionSurfaceCard kind="session.commands" payload={{ commands: document().session.commands ?? [] }}
                  appearance={sessionSurfaceAppearance(props.context, 'session.commands')}
                  commands={fallbackRenderCommands(props.context)} />}
              />
            </div>
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
          : ['activity.subagent', 'activity.delegation', 'activity.team'].includes(props.activity.semanticKind ?? '')
            ? <SolidSubagentCard activity={props.activity}
                appearance={{ ...props.context.appearanceSnapshot(), reducedMotion: props.context.input().reducedMotion }}
                commands={fallbackRenderCommands(props.context)} />
          : ['activity.workflow', 'activity.workflow-phase', 'activity.workflow-agent', 'activity.background-task'].includes(props.activity.semanticKind ?? '')
            ? <SolidWorkflowActivityCard activity={props.activity}
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

export function interactionRenderKind(interaction: WorkbenchInteraction): string {
  if (!interaction.request || typeof interaction.request !== 'object' || Array.isArray(interaction.request)) return 'interaction.questions'
  switch ((interaction.request as Record<string, unknown>).kind) {
    case 'approval': return 'interaction.approval'
    case 'confirm': return 'interaction.confirm'
    case 'permission':
      return 'interaction.permission'
    case 'oauth': return 'interaction.oauth'
    case 'secret': return 'interaction.secret'
    case 'sudo': return 'interaction.sudo'
    case 'clarify':
    case 'ask-question':
    default: return 'interaction.questions'
  }
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

function WorkbenchEmptyState(props: { status: string; workspaceMode: 'work' | 'chat'; context: SolidWorkbenchContextValue }) {
  const model = () => selectAgentEmptyState(props.workspaceMode)
  const workspaces = () => props.context.input().availableWorkspaces ?? []
  const [workspaceId, setWorkspaceId] = createSignal('')
  const [prompt, setPrompt] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)
  const [submitError, setSubmitError] = createSignal('')
  const submit = async () => {
    const text = prompt().trim()
    if (!text || submitting()) return
    if (props.workspaceMode === 'work' && !workspaceId()) {
      setSubmitError('请先选择工作区')
      return
    }
    setSubmitting(true)
    setSubmitError('')
    try {
      const created = await props.context.commands.createSession({
        ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
        initialPrompt: { text },
      })
      if (!created.sessionId) throw new Error('会话创建未返回有效标识')
      setPrompt('')
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div class="solid-workbench-empty agent-empty-state" data-status={props.status} data-workspace-mode={props.workspaceMode} role="region" aria-label="Agent 工作台空态">
      <div class="agent-empty-brand" aria-hidden="true">
        <svg class="pylon-mark" width="52" height="52" viewBox="0 0 64 64">
          <path class="pylon-mark-frame" d="M32 7 53 19v26L32 57 11 45V19Z" />
          <circle class="pylon-mark-node" cx="32" cy="21.215" r="4" />
          <circle class="pylon-mark-node" cx="20" cy="42" r="4" />
          <circle class="pylon-mark-node" cx="44" cy="42" r="4" />
          <path class="pylon-mark-links" d="m30 24.679-8 13.857m20 0-8-13.857M24 42h16" />
        </svg>
      </div>
      <div class="agent-empty-eyebrow">{model().eyebrow}</div>
      <h2 class="agent-empty-title">{model().title}</h2>
      <p class="agent-empty-description">{props.workspaceMode === 'work'
        ? '选择项目并描述任务，Pylon 会创建带工作上下文的会话。'
        : '直接输入第一条消息，Pylon 会创建会话并让 Agent 立即开始回应。'}</p>
      <form class="solid-agent-empty-composer" onSubmit={event => { event.preventDefault(); void submit() }}>
        <Show when={props.workspaceMode === 'work'}>
          <label class="solid-agent-empty-workspace">
            <span>工作区</span>
            <select aria-label="新会话工作区" value={workspaceId()} onChange={event => { setWorkspaceId(event.currentTarget.value); setSubmitError('') }}>
              <option value="">{workspaces().length > 0 ? '选择工作区…' : '暂无工作区，请先在左栏创建'}</option>
              {workspaces().map(item => <option value={item.id}>{item.label} · {item.path}</option>)}
            </select>
          </label>
        </Show>
        <textarea
          aria-label="首条请求"
          value={prompt()}
          placeholder={props.workspaceMode === 'work' ? '描述你想让 Agent 在这个项目中完成什么…' : '向 Agent 发送第一条消息…'}
          disabled={submitting()}
          onInput={event => { setPrompt(event.currentTarget.value); setSubmitError('') }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
            event.preventDefault()
            void submit()
          }}
        />
        <div class="solid-agent-empty-composer-footer">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <button type="submit" disabled={!prompt().trim() || submitting() || (props.workspaceMode === 'work' && !workspaceId())}>
            {submitting() ? '正在创建…' : '开始新会话'}
          </button>
        </div>
        <Show when={submitError()}>{message => <div class="solid-agent-empty-error" role="alert">{message()}</div>}</Show>
      </form>
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
  if (part.kind === 'memory' || part.kind === 'skill' || part.kind === 'mcp-resource' || part.kind === 'artifact') {
    return <SolidExtensionContentCard
      kind={`content.${part.kind}`}
      payload={part}
      appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion === true }}
      commands={fallbackRenderCommands(context)}
    />
  }
  const summary = part.kind === 'unknown' ? part.summary : `Unsupported content kind: ${part.kind}`
  return <pre class="solid-content-unknown" data-content-kind={part.kind}>{summary}</pre>
}

function renderExtensionFallback(extension: WorkbenchExtensionNode, context: SolidWorkbenchContextValue) {
  const provenance = <div class="solid-extension-provenance">
    <small>{extension.source.provider} · {extension.source.sourceId}</small>
    <small>{extension.provenance.origin} · {extension.provenance.trust}</small>
  </div>
  if (extension.kind === 'system.hook' && isValidHookSurfaceInput(extension.payload)) {
    return <section class="solid-extension-fallback" data-extension-kind={extension.kind}>
      {provenance}
      <SolidExtensionContentCard
        kind="system.hook"
        payload={extension.payload}
        appearance={{ ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion === true }}
        commands={fallbackRenderCommands(context)}
      />
    </section>
  }
  const fallback = extension.fallback.length > 0
    ? extension.fallback
    : [{ kind: 'unknown', originalType: extension.kind, summary: `Unsupported extension: ${extension.kind}`, raw: {}, truncated: false }] as const
  return <section class="solid-extension-fallback" role="note" aria-label={`扩展事件：${extension.kind}`} data-extension-kind={extension.kind}>
    <strong>{extension.kind}</strong>
    {provenance}
    <For each={fallback}>{part => renderBuiltinContentPart(part, false, context)}</For>
  </section>
}

function fallbackRenderCommands(context: SolidWorkbenchContextValue): RenderCommandPort {
  const sessionId = context.input().sessionId
  const capabilities = context.hostPort?.capabilities
  return {
    canExecute: type => Boolean(sessionId && capabilities && canExecuteRendererSemanticCommand(type, capabilities)),
    execute: command => {
      const host = context.hostPort
      if (!host) return Promise.resolve()
      return executeRendererSemanticCommand({
        command,
        host,
        mountInput: normalizeWorkbenchMountInput(context.input()),
      })
    },
  }
}

function sessionSurfaceAppearance(context: SolidWorkbenchContextValue, kind: string) {
  return context.hostPort?.appearance.resolve?.({
    kind,
    suiteId: context.activation?.suite.value.id ?? 'builtin.solid',
    slotId: 'builtin.solid.content.base',
  }) ?? { ...context.appearanceSnapshot(), reducedMotion: context.input().reducedMotion === true }
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
