import { ErrorBoundary, For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js'
import { buildChatRowDescriptors, isToolRenderMessage } from '../../components/chat/chatRowPipeline.ts'
import { buildMessageLookups } from '../../components/chat/messageLookups.ts'
import { prepareMessages } from '../../components/chat/messagePipeline.ts'
import type { Message, RenderMessage } from '../../components/chat/messageTypes.ts'
import type { WorkbenchAppearanceSnapshot } from '../../domains/workbench/appearance.ts'
import { toolInvocationSnapshot, type WorkbenchActivityNode, type WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
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
import { fallbackRenderCommands, renderBuiltinContentPart, renderExtensionFallback, sessionSurfaceAppearance } from './solidBuiltinContentRenderer.solid.tsx'
import { canonicalTokenCount, interactionRenderKind, lifecycleRenderKind, selectActivityTimelinePlacement, toSolidMessage, type ActivityTimelinePlacement, deriveCanonicalToolConnectorSources } from './solidWorkbenchProjectionSupport.ts'
import { isControlCenterConfigOption } from './input/workbenchOptionCatalog.ts'

// Compatibility export for the existing interaction kind contract/tests.
export { interactionRenderKind } from './solidWorkbenchProjectionSupport.ts'

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
  let chatContent: HTMLDivElement | undefined
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
    chatContent = undefined
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
    const sync = () => {
      syncScrollRail()
      if (followBottom()) queueBottomFollow()
    }
    queueMicrotask(sync)
    if (typeof window !== 'undefined') window.addEventListener('resize', sync)
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(sync)
      if (scrollRailTrack) observer.observe(scrollRailTrack)
      if (chatViewport) observer.observe(chatViewport)
      // Streaming text, reasoning blocks, async Markdown/highlighting and
      // image loads live outside PlainMessageList. Observe the content rail
      // itself so those height changes follow the bottom while sticky, without
      // taking scroll ownership from a user who has scrolled up.
      if (chatContent) observer.observe(chatContent)
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
        fallback={<div class="solid-workbench-empty-space">
          <WorkbenchEmptyBrand workspaceMode={props.context.input().workspaceMode ?? 'work'} />
        </div>}
      >
        <div class="solid-workbench-chat-shell">
          <div
            ref={node => { chatViewport = node }}
            class="chat-view solid-workbench-chat"
            onScroll={event => updateBottomFollow(event.currentTarget)}
          >
            <div ref={node => { chatContent = node }} class="term">
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
                {text => <div class="term-row term-row-reasoning" data-render-type="reasoning" data-streaming="true">
                  <ReasoningBlock text={text()} running />
                </div>}
              </Show>
              <WorkbenchDocumentSurface document={document()} context={props.context} commands={props.context.commands} sessionId={props.context.input().sessionId} reducedMotion={props.context.input().reducedMotion ?? false} />
              <Show when={snapshot().streamingText}>
                {text => <div class="term-row term-row-assistant" data-render-type="assistant" data-streaming="true">
                  <AssistantContent text={text()} appearance={appearance()} streaming />
                </div>}
              </Show>
              <SolidGenerationFooter
                running={snapshot().generating}
                // The runtime snapshot carries the document and live
                // generation projection together.  Use its session identity
                // (rather than the independently-updated mount input) so a
                // session switch cannot reset the footer against the previous
                // session's start timestamp for one render.
                generationKey={snapshot().sessionId ?? ''}
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
      </Show>
      <Show when={!props.context.input().replayReadonly}>
        <SolidControlCenter />
      </Show>
      <Show when={props.context.input().replayReadonly && props.context.input().sessionId}>
        <div class="solid-workbench-replay-overlay" role="status">历史回放 · 只读</div>
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
}) {
  /**
   * `session.started` carries the ACP negotiation catalogue.  Those model /
   * mode / reasoning entries are consumed by the control-center selectors and
   * must not become a second, persistent config form below the conversation.
   * A later ordinary `session.config-updated` event is intentionally kept
   * visible when there was no startup negotiation; existing agents use that
   * event for editable runtime settings and it must retain its editor.
   *
   * Keep this check on the projected timeline rather than guessing from the
   * option id alone.  `id: "model"` is also a valid ordinary config option,
   * and filtering it unconditionally regresses the normal config surface.
   */
  const hasSessionStartNegotiation = () => props.document?.timeline.some(entry => {
    if (entry.kind !== 'session' || !entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) return false
    const event = entry.data as { type?: unknown; options?: unknown }
    return event.type === 'session.started' && Array.isArray(event.options)
  }) ?? false
  const visibleConfigOptions = () => {
    const options = props.document?.session.options ?? []
    return hasSessionStartNegotiation()
      ? options.filter(option => !isControlCenterConfigOption(option))
      : options
  }
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
          <Show when={visibleConfigOptions().length > 0}>
            <div class="solid-workbench-config" data-config-count={visibleConfigOptions().length}>
              <WorkbenchContentSlot
                nodeId={`${props.sessionId ?? 'none'}:session:config`}
                kind="session.config"
                payload={{ options: visibleConfigOptions() }}
                context={props.context}
                fallback={<SolidSessionSurfaceCard kind="session.config" payload={{ options: visibleConfigOptions() }}
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

/** Brand-only empty-state layer. The control center remains the sole input
 * surface; this block provides recognition without duplicating instructions,
 * context rows, or creation controls. */
function WorkbenchEmptyBrand(props: { workspaceMode: 'work' | 'chat' }) {
  const model = () => selectAgentEmptyState(props.workspaceMode)
  return <div class="agent-empty-state solid-workbench-empty-brand" data-workspace-mode={props.workspaceMode} role="img" aria-label="Pylon Agent">
    <div class="agent-empty-lockup" aria-hidden="true">
      <div class="agent-empty-brand">
        <svg class="pylon-mark" width="52" height="52" viewBox="0 0 64 64">
        <path class="pylon-mark-frame" d="M32 7 53 19v26L32 57 11 45V19Z" />
        <circle class="pylon-mark-node" cx="32" cy="21.215" r="4" />
        <circle class="pylon-mark-node" cx="20" cy="42" r="4" />
        <circle class="pylon-mark-node" cx="44" cy="42" r="4" />
        <path class="pylon-mark-links" d="m30 24.679-8 13.857m20 0-8-13.857M24 42h16" />
        </svg>
      </div>
      <span class="agent-empty-wordmark">PYLON</span>
    </div>
    <div class="agent-empty-eyebrow">{model().eyebrow}</div>
    <h2 class="agent-empty-title">{model().title}</h2>
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
