import { ErrorBoundary, For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js'
import { buildChatRowDescriptors, isToolRenderMessage } from '../../components/chat/chatRowPipeline.ts'
import { buildMessageLookups } from '../../components/chat/messageLookups.ts'
import { prepareMessages } from '../../components/chat/messagePipeline.ts'
import type { Message, RenderMessage } from '../../components/chat/messageTypes.ts'
import type { WorkbenchAppearanceSnapshot } from '../../domains/workbench/appearance.ts'
import { selectActivityDisplayOrder, toolInvocationSnapshot, type WorkbenchActivityNode, type WorkbenchDocument, type WorkbenchInteraction } from '../../domains/workbench/workbenchProjector.ts'
import { groupAdjacentToolActivities, type AdjacentToolActivityGroup } from '../../domains/workbench/activityGrouping.ts'
import { coalesceAdjacentDisplayTextParts, type ContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import type { MessageListItem } from '../../domains/workbench/messageListPort.ts'
import { MESSAGE_LIST_BOTTOM_THRESHOLD_PX } from '../../domains/workbench/messageViewportState.ts'
import { INSTANT_LOCK_MS, SMOOTH_LOCK_MS } from '../../components/chat/scrollFollowState.ts'
import { createToolConnectorLayoutPort } from '../../domains/workbench/toolConnectorLayoutPort.ts'
import { AssistantContent, ReasoningBlock, SolidMessageRow } from './chat/MessageRow.solid.tsx'
import { PlainMessageList } from './chat/PlainMessageList.solid.tsx'
import { SolidToolCard } from './chat/ToolCard.solid.tsx'
import { SolidToolConnectorLayer, type SolidToolConnectorEdge, type ToolConnectorAppearance } from './chat/ToolConnector.solid.tsx'
import { SolidGenerationFooter } from './chat/GenerationFooter.solid.tsx'
import { SolidControlCenter } from './input/ControlCenter.solid.tsx'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { SolidRendererSlotHost } from './chat/RendererSlotHost.solid.tsx'
import { SolidPlanGoalContent } from './chat/content/PlanGoalContent.solid.tsx'
import type { LifecycleState } from '../../domains/workbench/lifecycle/lifecycleModel.ts'
import { SolidLifecycleCard, SolidSystemErrorCard, SolidSystemNoticeCard } from './chat/LifecycleCard.solid.tsx'
import { SolidToolInvocationCard } from './chat/ToolInvocationCard.solid.tsx'
import { measureToolAnchor } from './chat/domToolConnectorMeasurement.ts'
import { SolidProcessActivity } from './chat/content/TerminalBlock.solid.tsx'
import { SolidSubagentCard } from './chat/content/SubagentCard.solid.tsx'
import { SolidWorkflowActivityCard } from './chat/content/WorkflowCard.solid.tsx'
import { SolidInteractionCard } from './chat/content/InteractionCard.solid.tsx'
import { SolidSessionSurfaceCard } from './chat/content/SessionSurfaceCard.solid.tsx'
import { messageMatchesQuery, searchValuesMatchQuery } from '../../components/chat/messageSearchIndex.ts'
import { createSessionUiSignal } from './adapters/sessionUiSignal.solid.tsx'
import { selectAgentEmptyState } from '../../domains/workbench/agentEmptyState.ts'
import { capitalizeToolName } from '../../components/chat/toolPresentationModel.ts'
import type { WorkbenchAttachment } from '../../domains/workbench/workbenchCommandFacade.ts'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore.ts'
import { useIdentityStore } from '../../identityStore.ts'
import { fallbackRenderCommands, renderBuiltinContentPart, renderExtensionFallback, sessionSurfaceAppearance } from './solidBuiltinContentRenderer.solid.tsx'

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
  let chatViewport: HTMLDivElement | undefined
  let scrollRailTrack: HTMLDivElement | undefined
  let stopScrollRailDrag: (() => void) | undefined
  const [scrollRailMetrics, setScrollRailMetrics] = createSignal({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    trackHeight: 0,
  })
  let followedSessionId: string | null | undefined
  // Programmatic scrolls emit the same `scroll` events as user input. Keep
  // those feedback events from briefly flipping the follow state while a
  // button animation is in flight, and invalidate any already queued
  // auto-follow microtask when the user chooses an explicit endpoint.
  let followLockUntil = 0
  let scrollActionRevision = 0
  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
  const beginScrollAction = (nextFollowBottom: boolean, behavior: ScrollBehavior) => {
    scrollActionRevision += 1
    followLockUntil = now() + (behavior === 'smooth' ? SMOOTH_LOCK_MS : INSTANT_LOCK_MS)
    setFollowBottom(nextFollowBottom)
  }
  onCleanup(() => {
    bottomAnchor = undefined
    chatViewport = undefined
    scrollRailTrack = undefined
    stopScrollRailDrag?.()
    stopScrollRailDrag = undefined
    followLockUntil = 0
    scrollActionRevision += 1
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
  const activityPlacement = createMemo(() => selectActivityTimelinePlacement(
    snapshot().messages.some(message => message.role === 'tool') ? undefined : document(),
  ))
  const connectorEdges = createMemo<readonly SolidToolConnectorEdge[]>(() => mergeToolConnectorEdges(
    buildLegacyToolConnectorEdges(descriptors(), appearance()),
    buildCanonicalToolConnectorEdges(activityPlacement(), document(), props.context),
  ))

  const scrollRailThumb = createMemo(() => {
    const metrics = scrollRailMetrics()
    const maxScroll = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
    const trackHeight = Math.max(0, metrics.trackHeight)
    if (trackHeight <= 0 || maxScroll <= 0 || metrics.scrollHeight <= 0) {
      return { visible: false, height: trackHeight, offset: 0, maxScroll }
    }
    const height = Math.min(
      trackHeight,
      Math.max(28, trackHeight * metrics.clientHeight / metrics.scrollHeight),
    )
    const travel = Math.max(0, trackHeight - height)
    const progress = Math.min(1, Math.max(0, metrics.scrollTop / maxScroll))
    return { visible: true, height, offset: travel * progress, maxScroll }
  })

  const syncScrollRail = (viewport = chatViewport) => {
    if (!viewport) return
    const trackHeight = scrollRailTrack?.getBoundingClientRect().height ?? 0
    const next = {
      scrollTop: Math.max(0, viewport.scrollTop),
      scrollHeight: Math.max(0, viewport.scrollHeight),
      clientHeight: Math.max(0, viewport.clientHeight),
      trackHeight: Math.max(0, trackHeight),
    }
    setScrollRailMetrics(previous => (
      previous.scrollTop === next.scrollTop
      && previous.scrollHeight === next.scrollHeight
      && previous.clientHeight === next.clientHeight
      && previous.trackHeight === next.trackHeight
        ? previous
        : next
    ))
  }

  const updateBottomFollow = (viewport: HTMLDivElement) => {
    syncScrollRail(viewport)
    if (now() < followLockUntil) return
    const distance = Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)
    setFollowBottom(distance <= MESSAGE_LIST_BOTTOM_THRESHOLD_PX)
  }

  const eventElement = (event?: Event) => {
    const current = event?.currentTarget
    if (current instanceof HTMLElement) return current
    const target = event?.target
    return target instanceof HTMLElement ? target : undefined
  }

  const viewportFromAction = (event?: Event) => {
    const target = eventElement(event)
    const shell = target?.closest<HTMLElement>('.solid-workbench-chat-shell')
    return shell?.querySelector<HTMLDivElement>('.chat-view') ?? chatViewport
  }

  const scrollViewportToBottom = (viewport: HTMLDivElement, behavior: ScrollBehavior) => {
    const top = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    if (typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ top, behavior })
    } else {
      viewport.scrollTop = top
    }
    // Keep the model in sync immediately as well. Native scrollTo updates
    // asynchronously for smooth scrolling, while jsdom/test hosts may only
    // expose a spy; assigning the endpoint makes the follow state deterministic.
    viewport.scrollTop = top
    syncScrollRail(viewport)
  }

  const stopScrollRailPointerDrag = () => {
    stopScrollRailDrag?.()
    stopScrollRailDrag = undefined
  }

  const beginScrollRailThumbDrag = (event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const viewport = viewportFromAction(event)
    const thumb = eventElement(event)?.closest<HTMLElement>('.solid-workbench-scroll-thumb')
    const track = thumb?.closest<HTMLElement>('.solid-workbench-scroll-track')
    if (!viewport || !(thumb instanceof HTMLElement) || !track) return

    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const trackHeight = track.getBoundingClientRect().height
    const thumbHeight = thumb.getBoundingClientRect().height
    const travel = Math.max(1, trackHeight - thumbHeight)
    if (maxScroll <= 0 || trackHeight <= 0) return

    stopScrollRailPointerDrag()
    thumb.dataset.dragging = 'true'
    const startY = event.clientY
    const startScrollTop = viewport.scrollTop
    const pointerId = event.pointerId
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      const progress = (next.clientY - startY) / travel
      viewport.scrollTop = Math.min(maxScroll, Math.max(0, startScrollTop + progress * maxScroll))
      syncScrollRail(viewport)
    }
    const stop = (next?: PointerEvent) => {
      if (next && next.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (thumb.dataset.dragging === 'true') delete thumb.dataset.dragging
      if (stopScrollRailDrag === stop) stopScrollRailDrag = undefined
    }
    stopScrollRailDrag = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const seekScrollRailTrack = (event: MouseEvent | PointerEvent) => {
    const targetElement = eventElement(event)
    if (targetElement?.closest('.solid-workbench-scroll-thumb')) return
    event.preventDefault()
    const viewport = viewportFromAction(event)
    const track = targetElement?.closest<HTMLElement>('.solid-workbench-scroll-track')
    if (!viewport || !(track instanceof HTMLElement)) return
    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const trackRect = track.getBoundingClientRect()
    const thumbHeight = scrollRailThumb().height
    const travel = Math.max(1, trackRect.height - thumbHeight)
    if (maxScroll <= 0 || trackRect.height <= 0) return
    const targetScrollTop = Math.min(
      travel,
      Math.max(0, event.clientY - trackRect.top - thumbHeight / 2),
    )
    viewport.scrollTop = targetScrollTop / travel * maxScroll
    syncScrollRail(viewport)
  }

  const handleScrollRailKeyDown = (event: KeyboardEvent) => {
    const viewport = viewportFromAction(event)
    if (!viewport) return
    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    if (maxScroll <= 0) return
    const page = Math.max(48, viewport.clientHeight * 0.9)
    let target: number | undefined
    switch (event.key) {
      case 'ArrowUp':
        target = viewport.scrollTop - 48
        break
      case 'ArrowDown':
        target = viewport.scrollTop + 48
        break
      case 'PageUp':
        target = viewport.scrollTop - page
        break
      case 'PageDown':
        target = viewport.scrollTop + page
        break
      case 'Home':
        target = 0
        break
      case 'End':
        target = maxScroll
        break
      default:
        return
    }
    event.preventDefault()
    viewport.scrollTop = Math.min(maxScroll, Math.max(0, target))
    syncScrollRail(viewport)
  }

  const queueBottomFollow = () => {
    const revision = scrollActionRevision
    queueMicrotask(() => {
      if (revision !== scrollActionRevision || !followBottom()) return
      if (chatViewport) scrollViewportToBottom(chatViewport, 'auto')
    })
  }

  const scrollToTop = (event?: Event) => {
    const viewport = viewportFromAction(event)
    if (!viewport) return
    const behavior = props.context.input().reducedMotion ? 'auto' : 'smooth'
    beginScrollAction(false, behavior)
    if (typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ top: 0, behavior })
    } else {
      viewport.scrollTop = 0
    }
  }

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
    followLockUntil = 0
    scrollActionRevision += 1
    setFollowBottom(true)
  })
  createEffect(() => {
    sessionId()
    snapshot()
    queueMicrotask(() => syncScrollRail())
    if (!followBottom()) return
    queueBottomFollow()
  })

  onMount(() => {
    const sync = () => syncScrollRail()
    queueMicrotask(sync)
    if (typeof window !== 'undefined') window.addEventListener('resize', sync)
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(sync)
      if (scrollRailTrack) observer.observe(scrollRailTrack)
      if (chatViewport) observer.observe(chatViewport)
    }
    onCleanup(() => {
      if (typeof window !== 'undefined') window.removeEventListener('resize', sync)
      observer?.disconnect()
    })
  })

  const resumeBottomFollow = (event?: Event) => {
    const behavior = props.context.input().reducedMotion ? 'auto' : 'smooth'
    beginScrollAction(true, behavior)
    const viewport = viewportFromAction(event)
    if (viewport) scrollViewportToBottom(viewport, behavior)
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
      style={{
        '--right-panel-inset': `${Math.max(0, props.context.input().rightInset ?? 0)}px`,
        '--input-font-size': 'var(--chat-font-size)',
      }}
      aria-label="Solid Agent Workbench"
    >
      <Show when={snapshot().status === 'error'}>
        <div class="solid-workbench-runtime-error" role="alert">{snapshot().error || '工作台运行时错误'}</div>
      </Show>
      <Show
        when={props.context.input().sessionId}
        fallback={<WorkbenchEmptyState
          status={snapshot().status}
          availableModels={snapshot().availableModels}
          activeModel={snapshot().activeModel}
          availableModes={snapshot().availableModes}
          activeMode={snapshot().activeMode}
          workspaceMode={props.context.input().workspaceMode ?? 'work'}
          context={props.context}
        />}
      >
        <div class="solid-workbench-chat-shell">
          <div
            ref={node => { chatViewport = node }}
            class="chat-view solid-workbench-chat"
            onScroll={event => updateBottomFollow(event.currentTarget)}
          >
            <div class="term">
              <SolidToolConnectorLayer edges={connectorEdges()} layoutPort={connectorPort} />
              <CanonicalActivityList
                activities={activityPlacement().leading}
                document={document()}
                context={props.context}
                connectorPort={connectorPort}
              />
              <PlainMessageList
                initialItems={items()}
                renderItem={item => <WorkbenchRow
                  descriptor={item.descriptor}
                  appearance={appearance()}
                  connectorPort={connectorPort}
                  context={props.context}
                >
                  <CanonicalActivityList
                    activities={activityPlacement().afterMessage.get(item.descriptor.renderMessage.message.id) ?? []}
                    document={document()}
                    context={props.context}
                    connectorPort={connectorPort}
                  />
                </WorkbenchRow>}
                onPortReady={port => {
                  setMessageListPort(() => port)
                  port.setItems(items())
                }}
                onContentResize={() => {
                  syncScrollRail()
                  if (!followBottom()) return
                  queueBottomFollow()
                }}
              />
              <Show when={snapshot().streamingThinking}>
                {text => <div class="term-row term-row-reasoning" data-render-type="reasoning">
                  <ReasoningBlock text={text()} running />
                </div>}
              </Show>
              <WorkbenchDocumentSurface document={document()} context={props.context} commands={props.context.commands} sessionId={props.context.input().sessionId} reducedMotion={props.context.input().reducedMotion ?? false} />
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
                activity={snapshot().generationActivity}
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
          <div class="solid-workbench-scroll-rail" role="group" aria-label="聊天滚动导航">
            <button
              type="button"
              class="scroll-rail-btn scroll-top-btn"
              data-scroll-action="top"
              aria-label="回到顶部"
              title="回到顶部"
              onClick={scrollToTop}
            >▲</button>
            <div
              ref={node => { scrollRailTrack = node }}
              class="solid-workbench-scroll-track"
              role="scrollbar"
              aria-label="聊天滚动位置"
              aria-orientation="vertical"
              aria-valuemin="0"
              aria-valuemax={scrollRailThumb().maxScroll}
              aria-valuenow={Math.round(scrollRailMetrics().scrollTop)}
              tabIndex="0"
              onPointerDown={seekScrollRailTrack}
              onClick={seekScrollRailTrack}
              onKeyDown={handleScrollRailKeyDown}
            >
              <div
                class="solid-workbench-scroll-thumb"
                data-scrollable={scrollRailThumb().visible ? 'true' : 'false'}
                aria-hidden="true"
                style={{
                  height: `${scrollRailThumb().height}px`,
                  transform: `translateY(${scrollRailThumb().offset}px)`,
                }}
                onPointerDown={beginScrollRailThumbDrag}
              />
            </div>
            <button
              type="button"
              class="scroll-rail-btn scroll-bottom-btn"
              data-scroll-action="bottom"
              aria-label="回到底部"
              title="回到底部"
              onClick={resumeBottomFollow}
            >▼</button>
          </div>
        </div>
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
          <Show when={visibleDiagnostics(document()).length > 0}>
            <div class="solid-workbench-diagnostics" aria-label="诊断">
              <For each={visibleDiagnostics(document())}>{diagnostic => (
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

function visibleDiagnostics(document: WorkbenchDocument) {
  const errorEventIds = new Set(document.systemErrors.flatMap(error => error.eventId ? [error.eventId] : []))
  return document.diagnostics.filter(diagnostic => !errorEventIds.has(diagnostic.eventId))
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
    <div
      ref={root}
      class={`solid-workbench-activity-slot term-row ${props.activity.kind === 'tool' ? 'term-row-tool' : 'term-row-activity'}`}
      data-activity-id={props.activity.id}
    >
      <WorkbenchContentSlot
        nodeId={`${props.document.sessionId}:${props.activity.id}`}
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
              {capitalizeToolName(props.activity.title || props.activity.kind)} · {props.activity.status}
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

function buildLegacyToolConnectorEdges(
  descriptors: readonly MessageListItem['descriptor'][],
  appearance: WorkbenchAppearanceSnapshot,
): SolidToolConnectorEdge[] {
  const edges: SolidToolConnectorEdge[] = []
  const connectorAppearance = pickToolConnectorAppearance(appearance)
  for (let index = 1; index < descriptors.length; index += 1) {
    const current = descriptors[index]
    const previous = descriptors[index - 1]
    if (!current?.showConnector || !previous) continue
    if (!isToolRenderMessage(current.renderMessage) || !isToolRenderMessage(previous.renderMessage)) continue
    edges.push({
      key: `${previous.renderMessage.message.id}->${current.renderMessage.message.id}`,
      fromMessageId: previous.renderMessage.message.id,
      toMessageId: current.renderMessage.message.id,
      status: current.connectorStatus ?? 'run',
      visualState: normalizeToolVisualState(current.connectorVisualState),
      appearance: connectorAppearance,
    })
  }
  return edges
}

function buildCanonicalToolConnectorEdges(
  placement: ActivityTimelinePlacement,
  document: WorkbenchDocument | undefined,
  context: SolidWorkbenchContextValue,
): SolidToolConnectorEdge[] {
  if (!document) return []
  const activities = new Map(document.activities.map(activity => [activity.id, activity]))
  const connectorAppearance = resolveSolidToolConnectorAppearance(context)
  const segments: readonly (readonly WorkbenchActivityNode[])[] = [
    placement.leading,
    ...placement.afterMessage.values(),
  ]
  const edges: SolidToolConnectorEdge[] = []
  for (const segment of segments) {
    const sources = deriveCanonicalToolConnectorSources(segment)
    for (const activity of segment) {
      const sourceId = sources.get(activity.id)
      if (!sourceId) continue
      const source = activities.get(sourceId)
      edges.push({
        key: `${sourceId}->${activity.id}`,
        fromMessageId: sourceId,
        toMessageId: activity.id,
        status: toolConnectorTone(source?.status ?? activity.status),
        visualState: normalizeToolVisualState(source?.status ?? activity.status),
        appearance: connectorAppearance,
      })
    }
  }
  return edges
}

function mergeToolConnectorEdges(
  ...groups: readonly (readonly SolidToolConnectorEdge[])[]
): SolidToolConnectorEdge[] {
  const merged = new Map<string, SolidToolConnectorEdge>()
  for (const group of groups) {
    for (const edge of group) {
      // Legacy message rows are the authoritative representation when both
      // pipelines expose the same edge; do not register it twice.
      if (!merged.has(edge.key)) merged.set(edge.key, edge)
    }
  }
  return [...merged.values()]
}

function pickToolConnectorAppearance(appearance: WorkbenchAppearanceSnapshot): ToolConnectorAppearance {
  return {
    toolConnectorMode: appearance.toolConnectorMode,
    toolConnectorColor: appearance.toolConnectorColor,
    toolConnectorStyle: appearance.toolConnectorStyle,
    toolConnectorWidth: appearance.toolConnectorWidth,
    toolConnectorOpacity: appearance.toolConnectorOpacity,
  }
}

function resolveSolidToolConnectorAppearance(context: SolidWorkbenchContextValue): ToolConnectorAppearance {
  const host = context.appearanceSnapshot()
  const resolved = context.hostPort?.appearance.resolve?.({
    // Connector is owned by the generic lifecycle seam even when a
    // specialized tool kind falls back to the generic base Slot.
    kind: 'tool.generic',
    suiteId: context.activation?.suite.value.id ?? '',
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

function CanonicalActivityList(props: {
  activities: readonly WorkbenchActivityNode[]
  document: WorkbenchDocument | undefined
  context: SolidWorkbenchContextValue
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
}) {
  const [rows, setRows] = createSignal<readonly StableActivityRow[]>([])
  const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>({})
  let expandedSessionId: string | undefined
  createEffect(() => {
    const document = props.document
    const activities = props.activities
    if (!document) {
      setRows([])
      return
    }
    if (expandedSessionId !== document.sessionId) {
      expandedSessionId = document.sessionId
      setExpandedGroups({})
    }
    const previous = new Map(untrack(rows).map(row => [row.key, row]))
    setRows(activities.map(activity => {
      const key = `${document.sessionId}:${activity.id}`
      const existing = previous.get(key)
      if (!existing) return createStableActivityRow(key, activity)
      existing.update(activity)
      return existing
    }))
  })
  const groupedRows = createMemo(() => {
    const currentRows = rows()
    const groups = groupAdjacentToolActivities(currentRows.map(row => row.activity))
    const firstById = new Map(groups.map(group => [group.items[0]!.id, group]))
    const consumed = new Set<string>()
    const units: Array<StableActivityRow | AdjacentToolActivityGroup> = []
    for (const row of currentRows) {
      if (consumed.has(row.activity.id)) continue
      const group = firstById.get(row.activity.id)
      if (!group || group.count === 1) {
        units.push(row)
        continue
      }
      units.push(group)
      // Skip the remaining members; they are rendered inside the group row.
      for (const member of group.items) consumed.add(member.id)
    }
    return units
  })
  return <Show when={rows().length > 0 ? props.document : undefined}>
    {document => <div class="solid-workbench-activities" aria-label="活动" data-activity-count={rows().length}>
      <For each={groupedRows()}>{unit => {
        if ('items' in unit) {
          return <CanonicalActivityGroup
            group={unit}
            document={document()}
            context={props.context}
            connectorPort={props.connectorPort}
            open={expandedGroups()[unit.groupId] === true}
            onToggle={() => setExpandedGroups(previous => ({ ...previous, [unit.groupId]: !previous[unit.groupId] }))}
          />
        }
        return <CanonicalActivitySlot
          activity={unit.activity}
          document={document()}
          context={props.context}
          connectorPort={props.connectorPort}
        />
      }}</For>
    </div>}
  </Show>
}

function CanonicalActivityGroup(props: {
  group: AdjacentToolActivityGroup
  document: WorkbenchDocument
  context: SolidWorkbenchContextValue
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
  open: boolean
  onToggle: () => void
}) {
  const label = () => props.group.items[0]?.title || props.group.toolKey
  return <section class="solid-workbench-activity-group" data-activity-group={props.group.groupId} data-count={props.group.count}>
    <button
      class="solid-workbench-activity-group-head"
      type="button"
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <span>{capitalizeToolName(label())}</span>
      <span> · {props.group.count} 次调用 · {props.group.status === 'mixed' ? '状态混合' : props.group.status}</span>
    </button>
    <Show when={props.open}>
      <div class="solid-workbench-activity-group-items" role="group" aria-label={`${label()} 的单次调用`}>
        <For each={props.group.items}>{activity => <CanonicalActivitySlot
          activity={activity}
          document={props.document}
          context={props.context}
          connectorPort={props.connectorPort}
        />}</For>
      </div>
    </Show>
  </section>
}

/**
 * Derive incoming edges for one canonical activity segment.
 *
 * Canonical activities are rendered outside the legacy Message descriptor
 * pipeline, so `showConnector` is not available here.  Preserve explicit
 * parent edges and fill the missing flat-chain case by linking adjacent tool
 * nodes in the same segment.  Any non-tool activity is a hard boundary: it
 * starts a new visual chain rather than implying a relationship across it.
 */
function deriveCanonicalToolConnectorSources(
  activities: readonly WorkbenchActivityNode[],
): ReadonlyMap<string, string> {
  const sources = new Map<string, string>()
  let previousToolId: string | undefined

  for (const activity of activities) {
    if (activity.kind !== 'tool') {
      previousToolId = undefined
      continue
    }

    const parentId = activity.parentToolCallId
    if (parentId && parentId !== activity.id) {
      // Keep semantic parentage intact even when the parent is rendered in a
      // different activity segment; the layout port will hide an orphan edge
      // until both anchors are present.
      sources.set(activity.id, parentId)
    } else if (!parentId && previousToolId) {
      sources.set(activity.id, previousToolId)
    }
    previousToolId = activity.id
  }

  return sources
}

interface StableActivityRow {
  readonly key: string
  readonly activity: WorkbenchActivityNode
  update(activity: WorkbenchActivityNode): void
}

function createStableActivityRow(key: string, initialActivity: WorkbenchActivityNode): StableActivityRow {
  const [current, setCurrent] = createSignal(initialActivity)
  return {
    key,
    get activity() { return current() },
    update: setCurrent,
  }
}

interface ActivityTimelinePlacement {
  readonly leading: readonly WorkbenchActivityNode[]
  readonly afterMessage: ReadonlyMap<string, readonly WorkbenchActivityNode[]>
}

function selectActivityTimelinePlacement(document: WorkbenchDocument | undefined): ActivityTimelinePlacement {
  if (!document || document.activities.length === 0) {
    return { leading: [], afterMessage: new Map() }
  }
  const leading: WorkbenchActivityNode[] = []
  const afterMessage = new Map<string, WorkbenchActivityNode[]>()
  for (const activity of selectActivityDisplayOrder(document)) {
    let anchor: WorkbenchDocument['messages'][number] | undefined
    for (const message of document.messages) {
      if (message.sequence >= activity.sequence) continue
      if (!anchor || message.sequence > anchor.sequence) anchor = message
    }
    if (!anchor) {
      leading.push(activity)
      continue
    }
    const anchored = afterMessage.get(anchor.id) ?? []
    anchored.push(activity)
    afterMessage.set(anchor.id, anchored)
  }
  return { leading, afterMessage }
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

function WorkbenchEmptyState(props: { status: string; availableModels: readonly string[]; activeModel: string; availableModes: readonly string[]; activeMode: string; workspaceMode: 'work' | 'chat'; context: SolidWorkbenchContextValue }) {
  const model = () => selectAgentEmptyState(props.workspaceMode)
  const workspaces = () => props.context.input().availableWorkspaces ?? []
  const profileModel = props.activeModel || useIdentityStore.getState().profiles.find(item => item.id === useIdentityStore.getState().activeProfileId)?.model || ''
  const [workspaceId, setWorkspaceId] = createSignal('')
  const [prompt, setPrompt] = createSignal('')
  const [modelId, setModelId] = createSignal(profileModel)
  const [reasoningLevel, setReasoningLevel] = createSignal('balanced')
  const modeOptions = () => props.availableModes.length > 0 ? props.availableModes : ['default', 'edit', 'auto', 'bypass']
  const [mode, setMode] = createSignal(props.activeMode || modeOptions()[0] || 'default')
  const [attachments, setAttachments] = createSignal<readonly WorkbenchAttachment[]>([])
  const [submitting, setSubmitting] = createSignal(false)
  // Keep a local projection visible while the host is still creating the
  // session.  Session creation can involve ACP process startup, so waiting
  // for `input().sessionId` made the empty state appear frozen after submit.
  const [optimisticPrompt, setOptimisticPrompt] = createSignal<string>()
  const [submitError, setSubmitError] = createSignal('')
  const [workspaceDraft, setWorkspaceDraft] = createSignal<{ name: string; path: string }>()
  let promptInput: HTMLTextAreaElement | undefined
  let fileInput: HTMLInputElement | undefined
  onMount(() => {
    const onNewSession = (event: Event) => {
      const id = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId
      if (props.workspaceMode === 'work' && id) setWorkspaceId(id)
      setPrompt(''); setAttachments([]); setSubmitError('')
      queueMicrotask(() => promptInput?.focus())
    }
    window.addEventListener('pylon:new-session', onNewSession)
    onCleanup(() => window.removeEventListener('pylon:new-session', onNewSession))
    const onFolderPicked = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (path) setWorkspaceDraft({ name: path.split(/[\\\\/]/).filter(Boolean).at(-1) || '新工作区', path })
    }
    window.addEventListener('pylon:workspace-folder-picked', onFolderPicked)
    onCleanup(() => window.removeEventListener('pylon:workspace-folder-picked', onFolderPicked))
  })
  createEffect(() => {
    const options = workspaces(); const current = workspaceId()
    if (props.workspaceMode !== 'work') { if (current) setWorkspaceId(''); return }
    if (current && options.some(item => item.id === current)) return
    const recent = options.length ? options.reduce((a, b) => (b.lastActiveAt ?? 0) > (a.lastActiveAt ?? 0) ? b : a) : undefined
    const hasExplicitActivity = options.some(item => item.lastActiveAt !== undefined && item.lastActiveAt !== null)
    setWorkspaceId(options.length === 1 ? options[0]!.id : hasExplicitActivity ? recent?.id ?? '' : '')
  })
  const pickFolder = () => window.dispatchEvent(new CustomEvent('pylon:pick-workspace-folder'))
  const createWorkspace = async () => {
    const draft = workspaceDraft(); if (!draft?.name.trim() || !draft.path) return
    try { const workspace = await useWorkspaceEntityStore.getState().createWorkspace(draft.name.trim(), draft.path); setWorkspaceId(workspace.id); setWorkspaceDraft(); setSubmitError('') }
    catch (error) { setSubmitError(error instanceof Error ? error.message : '创建工作区失败') }
  }
  const submit = async () => {
    const text = prompt().trim(); if (!text || submitting()) return
    if (props.workspaceMode === 'work' && !workspaceId()) { setSubmitError('请先选择工作区'); return }
    setSubmitting(true); setSubmitError('')
    setOptimisticPrompt(text)
    try {
      const created = await props.context.commands.createSession({
        ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
        ...(modelId().trim() ? { model: modelId().trim() } : {}), reasoningLevel: reasoningLevel(), mode: mode(),
        initialPrompt: { text, attachments: attachments() },
      })
      if (!created.sessionId) throw new Error('会话创建未返回有效标识')
      setPrompt(''); setAttachments([])
    } catch (error) {
      setOptimisticPrompt()
      setSubmitError(error instanceof Error ? error.message : String(error)); queueMicrotask(() => promptInput?.focus())
    }
    finally { setSubmitting(false) }
  }
  return <div class="solid-workbench-empty agent-empty-state" data-status={props.status} data-workspace-mode={props.workspaceMode} role="region" aria-label="Agent 工作台空态" aria-busy={submitting()}>
    <div class="agent-empty-brand" aria-hidden="true"><svg class="pylon-mark" width="52" height="52" viewBox="0 0 64 64"><path class="pylon-mark-frame" d="M32 7 53 19v26L32 57 11 45V19Z" /><circle class="pylon-mark-node" cx="32" cy="21.215" r="4" /><circle class="pylon-mark-node" cx="20" cy="42" r="4" /><circle class="pylon-mark-node" cx="44" cy="42" r="4" /><path class="pylon-mark-links" d="m30 24.679-8 13.857m20 0-8-13.857M24 42h16" /></svg></div>
    <div class="agent-empty-eyebrow">{model().eyebrow}</div><h2 class="agent-empty-title">{model().title}</h2>
    <p class="agent-empty-description">配置工作上下文，然后发送第一条消息以创建会话。</p>
    <Show when={optimisticPrompt()}><div class="solid-agent-empty-optimistic" role="status" aria-label="正在创建会话">
      <div class="solid-agent-empty-optimistic-user"><span class="term-user-prefix">❯</span><span>{optimisticPrompt()}</span></div>
      <div class="solid-agent-empty-optimistic-status" aria-live="polite">正在创建会话…</div>
    </div></Show>
    <form class="solid-agent-empty-composer" onSubmit={event => { event.preventDefault(); void submit() }}>
      <Show when={props.workspaceMode === 'work'}><label class="solid-agent-empty-workspace"><span>工作区</span><select aria-label="新会话工作区" disabled={submitting() || workspaces().length === 0} value={workspaceId()} onChange={event => setWorkspaceId(event.currentTarget.value)}><option value="">选择工作区…</option>{workspaces().map(item => <option value={item.id}>{item.label} · {item.path}</option>)}</select><button type="button" disabled={submitting()} onClick={() => void pickFolder()}>新建…</button></label></Show>
      <Show when={workspaceDraft()}>{draft => <div class="solid-agent-empty-new-workspace"><input aria-label="新工作区名称" disabled={submitting()} value={draft().name} onInput={event => setWorkspaceDraft({ ...draft(), name: event.currentTarget.value })} /><code>{draft().path}</code><button type="button" disabled={submitting()} onClick={() => void createWorkspace()}>创建工作区</button></div>}</Show>
      <div class="solid-agent-empty-options"><label>模型<select aria-label="新会话模型" disabled={submitting()} value={modelId()} onChange={event => setModelId(event.currentTarget.value)}><option value="">Profile 默认</option><For each={props.availableModels}>{model => <option value={model}>{model}</option>}</For></select></label><label>权限模式<select aria-label="新会话权限模式" disabled={submitting()} value={mode()} onChange={event => setMode(event.currentTarget.value)}><For each={modeOptions()}>{item => <option value={item}>{item}</option>}</For></select></label><label>思考强度<select aria-label="新会话思考强度" disabled={submitting()} value={reasoningLevel()} onChange={event => setReasoningLevel(event.currentTarget.value)}><option value="fast">快速</option><option value="balanced">平衡</option><option value="deep">深入</option></select></label></div>
      <textarea ref={promptInput} aria-label="首条请求" value={prompt()} placeholder="描述你想让 Agent 完成什么…" disabled={submitting()} onInput={event => setPrompt(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit() } }} />
      <Show when={attachments().length}><div class="attached-files" aria-label="附件"><For each={attachments()}>{item => <button type="button" class="attached-chip" onClick={() => setAttachments(items => items.filter(value => value.id !== item.id))}>{item.name || item.path} ×</button>}</For></div></Show>
      <input ref={fileInput} type="file" multiple hidden onChange={event => { const files = event.currentTarget.files; if (files) setAttachments(items => [...items, ...Array.from(files).map(file => ({ id: `${file.name}:${file.size}:${file.lastModified}`, name: file.name, path: (file as File & { path?: string }).path || file.name, mediaType: file.type || undefined }))]); event.currentTarget.value = '' }} />
      <div class="solid-agent-empty-composer-footer"><button type="button" disabled={submitting()} onClick={() => fileInput?.click()}>添加附件</button><span>Enter 发送 · Shift+Enter 换行</span><button type="submit" disabled={!prompt().trim() || submitting() || (props.workspaceMode === 'work' && !workspaceId())}>{submitting() ? '正在创建…' : '开始新会话'}</button></div>
      <Show when={submitError()}>{message => <div class="solid-agent-empty-error" role="alert">{message()}</div>}</Show>
    </form>
  </div>
}
function WorkbenchRow(props: {
  descriptor: MessageListItem['descriptor']
  appearance: SolidWorkbenchContextValue['appearanceSnapshot'] extends () => infer T ? T : never
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
  context: SolidWorkbenchContextValue
  children?: import('solid-js').JSX.Element
}) {
  const current = () => props.descriptor.renderMessage
  const visualState = () => normalizeToolVisualState(props.descriptor.toolVisualState)
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
  return (
    <>
      <Switch>
        <Match when={current().type === 'tool_call' || current().type === 'tool_result'}>
          <div class="term-row term-row-tool" data-render-type={current().type}>
            <SolidToolCard
              message={current().message}
              visualState={visualState()}
              appearance={props.appearance}
              messageId={current().message.id}
              layoutPort={props.connectorPort}
            />
          </div>
        </Match>
        <Match when={slotCandidates().length > 0}>
          <SolidRendererSlotHost
            candidates={slotCandidates()}
            node={{ nodeId: current().message.id, kind: messageFrameKind() ?? 'content.unknown', revision: props.context.runtimeSnapshot().revision, payload: current() }}
            context={props.context}
            fallback={<WorkbenchDefaultMessage
              renderMessage={current()}
              appearance={props.appearance}
              highlighted={props.descriptor.isSearchMatch}
              context={props.context}
            />}
          />
        </Match>
        <Match when={true}>
          <WorkbenchDefaultMessage
            renderMessage={current()}
            appearance={props.appearance}
            highlighted={props.descriptor.isSearchMatch}
            context={props.context}
          />
        </Match>
      </Switch>
      {props.children}
    </>
  )
}

function WorkbenchDefaultMessage(props: {
  renderMessage: RenderMessage
  appearance: SolidWorkbenchContextValue['appearanceSnapshot'] extends () => infer T ? T : never
  highlighted: boolean
  context: SolidWorkbenchContextValue
}) {
  // Materialise the semantic subtree once. Passing the component expression
  // directly as a JSX prop makes every semanticContent read construct another
  // Slot host before Solid's role branch selects its visible child.
  const semanticContent = <WorkbenchMessageContent renderMessage={props.renderMessage} context={props.context} />
  return <SolidMessageRow
    renderMessage={props.renderMessage}
    appearance={props.appearance}
    highlighted={props.highlighted}
    semanticContent={semanticContent}
  />
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
    const redacted = () => message().redacted === true
    const kind = () => redacted() ? 'content.redacted-reasoning' : 'content.reasoning'
    const payload = () => redacted()
      ? { reason: message().redactedReason ?? 'provider_redacted' }
      : {
          text: message().content,
          state: message().running ? 'running' : message().content.trim() ? 'complete' : 'missing',
          ...(message().thoughtDurationMs !== undefined ? { durationMs: message().thoughtDurationMs } : {}),
        }
    return <Show keyed when={kind()}>{renderKind => <WorkbenchContentSlot
        nodeId={`${message().id}:reasoning`} kind={renderKind} payload={payload()}
        context={props.context}
        fallback={<ReasoningBlock
          text={message().content} running={message().running === true}
          startedAt={message().thoughtStartedAt} durationMs={message().thoughtDurationMs}
          redacted={redacted()} redactedReason={message().redactedReason}
        />}
      />}</Show>
  }
  const inline = props.renderMessage.type === 'user'
  // A provider stream commonly emits one semantic text part per delta. Each
  // part used to be parsed as an independent Markdown document, which made
  // every few-token chunk become its own block/line. Merge adjacent textual
  // parts before dispatching to the renderer; non-text parts stay boundaries.
  const renderParts = createMemo(() => coalesceAdjacentDisplayTextParts(parts()))
  return <Index each={renderParts()}>{(part, index) => (
    <WorkbenchMessagePart
      part={part}
      index={index}
      renderMessage={props.renderMessage}
      inline={inline}
      context={props.context}
    />
  )}</Index>
}

function WorkbenchMessagePart(props: {
  part: () => ContentPart
  index: number
  renderMessage: RenderMessage
  inline: boolean
  context: SolidWorkbenchContextValue
}) {
  const message = () => props.renderMessage.message
  const kind = () => contentRenderKind(props.part())
  const streaming = () => props.renderMessage.type === 'assistant'
    && message().running === true
    && (props.part().kind === 'text' || props.part().kind === 'markdown')
  // A payload update keeps the Slot instance. A semantic kind change is a real
  // boundary and must remount so candidate selection cannot retain the old kind.
  return <Show keyed when={kind()}>{renderKind => (
    <WorkbenchContentSlot
      nodeId={`${message().id}:part:${props.index}`}
      kind={renderKind}
      payload={props.part()}
      streaming={streaming()}
      context={props.context}
      fallback={renderBuiltinContentPart(props.part(), props.inline, props.context, streaming())}
    />
  )}</Show>
}

function WorkbenchContentSlot(props: {
  nodeId: string
  kind: string
  payload: unknown
  streaming?: boolean
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
      node={{
        nodeId: props.nodeId,
        kind: props.kind,
        revision: props.context.runtimeSnapshot().revision,
        payload: props.payload,
        ...(props.streaming === true ? { streaming: true } : {}),
      }}
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
