import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { buildChatRowDescriptors, isSameChatRowDescriptor } from '../../components/chat/chatRowPipeline.ts'
import { buildMessageLookups } from '../../components/chat/messageLookups.ts'
import { prepareMessages } from '../../components/chat/messagePipeline.ts'
import type { Message } from '../../components/chat/messageTypes.ts'
import type { MessageListItem } from '../../domains/workbench/messageListPort.ts'
import { MESSAGE_LIST_BOTTOM_THRESHOLD_PX } from '../../domains/workbench/messageViewportState.ts'
import { classifyScrollEvent, HYDRATING_MS, INSTANT_LOCK_MS, scrollTraceThreshold, SMOOTH_LOCK_MS, type ScrollWriteTrace } from '../../components/chat/scrollFollowModel.ts'
import { createScrollUserIntent } from '../../components/chat/scrollUserIntent.ts'
import { createToolConnectorLayoutPort } from '../../domains/workbench/toolConnectorLayoutPort.ts'
import { buildLegacyToolConnectorEdges, buildCanonicalToolConnectorEdges, mergeToolConnectorEdges } from './toolConnectorProjection.ts'
import { PlainMessageList } from './chat/PlainMessageList.solid.tsx'
import { SolidToolConnectorLayer } from './chat/ToolConnector.solid.tsx'
import type { SolidToolConnectorEdge } from './toolConnectorContracts.ts'
import { SolidGenerationFooter } from './chat/GenerationFooter.solid.tsx'
import { SolidControlCenter } from './input/ControlCenter.solid.tsx'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { SolidPlanGoalContent } from './chat/content/PlanGoalContent.solid.tsx'
import { messageMatchesQuery } from '../../components/chat/messageSearchIndex.ts'
import { createSessionUiSignal } from './adapters/sessionUiSignal.solid.tsx'
import { selectAgentEmptyState } from '../../domains/workbench/agentEmptyState.ts'
import { canonicalTokenCount, selectActivityTimelinePlacement, toSolidMessage } from './solidWorkbenchProjectionSupport.ts'
import type { WorkbenchSessionCreationSnapshot } from '../../domains/workbench/workbenchCommandFacade.ts'
import { CanonicalActivityList } from './CanonicalActivityList.solid.tsx'
import { WorkbenchDocumentSurface } from './WorkbenchDocumentSurface.solid.tsx'
import { WorkbenchRow, isAuthoritativelyLive } from './WorkbenchRow.solid.tsx'
import { WorkbenchContentSlot } from './WorkbenchContentSlot.solid.tsx'

export interface WorkbenchContentProps {
  context: SolidWorkbenchContextValue
}

export function WorkbenchContent(props: WorkbenchContentProps) {
  const snapshot = () => props.context.runtimeSnapshot()
  const appearance = () => props.context.appearanceSnapshot()
  const connectorPort = createToolConnectorLayoutPort()
  const [messageListPort, setMessageListPort] = createSignal<import('../../domains/workbench/messageListPort.ts').MessageListPort>()
  const [followBottom, setFollowBottom] = createSignal(true)
  const sessionId = () => props.context.input().sessionId
  const sessionCreationReader = () => props.context.sessionCreation ?? props.context.commands.sessionCreation
  const [sessionCreation, setSessionCreation] = createSignal<WorkbenchSessionCreationSnapshot>(
    sessionCreationReader()?.getSnapshot() ?? { phase: 'idle', sessionId: null, error: null, attempt: 0 },
  )
  onMount(() => {
    const reader = sessionCreationReader()
    if (!reader) return
    const sync = () => setSessionCreation(reader.getSnapshot())
    sync()
    onCleanup(reader.subscribe(sync))
  })
  const creationProgressVisible = () => sessionCreation().phase === 'creating-session' && !sessionId()
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
  let bottomFollowQueued = false
  let bottomFollowFrame: number | undefined
  let lastAutoFollowTop: number | undefined
  let lastObservedScrollTop = 0
  let followedSnapshotRevision: number | undefined
  // Programmatic scrolls emit the same `scroll` events as user input. Keep
  // those feedback events from briefly flipping the follow state while a
  // button animation is in flight, and invalidate any already queued
  // auto-follow microtask when the user chooses an explicit endpoint.
  let followLockUntil = 0
  /**
   * #212 S4 水合窗口：`sessionId` 落定后的这一小段里，行高会从骨架/首解析收敛到真高，
   * 期间"到底/没到底"的瞬态翻转不是用户意图——忽略它，避免页脚与吸底状态来回跳。
   */
  let hydratingUntil = 0
  let scrollActionRevision = 0
  // P57 S1.1（R-C1）：写迹与 lastAutoFollowTop 必须分离——后者每个 snapshot revision
  // 被置 undefined（新内容机会去重），复用它做判别会在风暴中失效。写迹只在
  // 三处清除：用户输入模态、beginScrollAction、新写覆盖。
  let lastProgrammaticWrite: ScrollWriteTrace | undefined
  // P57 S1.3（R-C5）：smooth 跟随动画在途标志——期间 revision effect 不写 instant
  // 打断动画；清除 = 连续 2 帧距 endpoint <0.5px 且锁过期（取晚者），或任何用户
  // 取消路径。仅对回底动作置位（▲ 置 follow=false，applyFollow 本就不写）。
  let smoothInFlight = false
  let smoothWatchFrame: number | undefined
  let smoothArrivalStreak = 0
  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
  const scrollTraceThresholdPx = () => scrollTraceThreshold(typeof devicePixelRatio === 'number' ? devicePixelRatio : undefined)
  const stopSmoothWatch = () => {
    if (smoothWatchFrame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(smoothWatchFrame)
    smoothWatchFrame = undefined
    smoothArrivalStreak = 0
  }
  const beginSmoothWatch = () => {
    stopSmoothWatch()
    if (typeof requestAnimationFrame !== 'function') {
      // 无帧泵的宿主（jsdom 未 mock rAF）不存在 smooth 动画，直接解除守卫。
      smoothInFlight = false
      return
    }
    const step = () => {
      smoothWatchFrame = undefined
      const viewport = chatViewport
      if (!viewport || !smoothInFlight) return
      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      if (Math.abs(viewport.scrollTop - maxScroll) <= 0.5) smoothArrivalStreak += 1
      else smoothArrivalStreak = 0
      const lockExpired = now() >= followLockUntil
      if ((smoothArrivalStreak >= 2 && lockExpired) || now() >= followLockUntil + SMOOTH_LOCK_MS) {
        smoothInFlight = false
        return
      }
      smoothWatchFrame = requestAnimationFrame(step)
    }
    smoothWatchFrame = requestAnimationFrame(step)
  }
  const beginScrollAction = (nextFollowBottom: boolean, behavior: ScrollBehavior) => {
    scrollActionRevision += 1
    lastObservedScrollTop = chatViewport?.scrollTop ?? 0
    lastAutoFollowTop = undefined
    lastProgrammaticWrite = undefined
    smoothInFlight = behavior === 'smooth' && nextFollowBottom
    followLockUntil = now() + (behavior === 'smooth' ? SMOOTH_LOCK_MS : INSTANT_LOCK_MS)
    if (smoothInFlight) beginSmoothWatch()
    setFollowBottom(nextFollowBottom)
  }
  // P57 S1.2：用户输入模态的取消路径（wheel 上滚 / touch 上滑判向 / viewport 键盘 /
  // 滚动条轨道拖拽）统一走这里：清迹、解除 smooth 守卫、作废排队写入、取消跟随。
  const cancelFollowForUserInput = () => {
    scrollActionRevision += 1
    lastObservedScrollTop = chatViewport?.scrollTop ?? 0
    followLockUntil = 0
    hydratingUntil = 0
    lastProgrammaticWrite = undefined
    // Releasing our guard alone does not stop the browser's smooth animation.
    if (smoothInFlight && chatViewport) {
      chatViewport.scrollTo({ top: chatViewport.scrollTop, behavior: 'instant' })
    }
    smoothInFlight = false
    stopSmoothWatch()
    setFollowBottom(false)
  }
  const scrollIntent = createScrollUserIntent(cancelFollowForUserInput)
  onCleanup(() => {
    bottomAnchor = undefined
    chatViewport = undefined
    chatContent = undefined
    scrollRailTrack = undefined
    stopScrollRailDrag?.()
    stopScrollRailDrag = undefined
    followLockUntil = 0
    hydratingUntil = 0
    scrollActionRevision += 1
    bottomFollowQueued = false
    if (bottomFollowFrame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(bottomFollowFrame)
    bottomFollowFrame = undefined
    lastAutoFollowTop = undefined
    followedSnapshotRevision = undefined
    lastProgrammaticWrite = undefined
    smoothInFlight = false
    stopSmoothWatch()
    connectorPort.destroy()
  })
  const document = () => snapshot().document
  const displayDocument = createMemo(() => {
    // Ownership is resolved once, at the message-list seam. Keep the canonical
    // document intact for activity placement, diagnostics and other readers.
    return document()
  })
  // P52 D5：transient 流字段已死（D3 后无生产写入者）——canonical running 行
  // 是唯一流式显示；此前的 transient 兜底 memo 与 appendTransient 注入随之退役。
  const viewMessages = createMemo<readonly Message[]>(() => {
    const legacy = snapshot().messages
    const projected = displayDocument()?.messages
    // Canonical document messages are the sole owner whenever available. The
    // legacy list remains only as a compatibility fallback for preview hosts
    // that have not mounted a WorkbenchDocument yet (including legacy tool
    // rows); mixing the two lists would reintroduce duplicate stream owners.
    const canonical = projected ?? []
    if (canonical.length === 0 && legacy.length > 0) return legacy
    const legacyToolIds = new Set(legacy.filter(message => message.role === 'tool').map(message => message.id))
    const base = canonical
      .filter(message => !(legacyToolIds.has(message.id) && message.role === 'assistant' && message.content.length === 0))
      .map(toSolidMessage)
    // Legacy preview hosts still expose tool rows before their activity
    // projection is available. Preserve those non-text rows without merging
    // legacy assistant/reasoning rows back into the canonical stream.
    // (P57 S2-R3：base 是本 memo 新建数组，直接追加 legacy tool 行，省一次展开拷贝。)
    for (const message of legacy) {
      if (message.role === 'tool') base.push(message)
    }
    return base
  })
  const renderMessages = createMemo(() => prepareMessages(viewMessages()))
  const searchMatches = createMemo(() => {
    if (!searchQuery().trim()) return []
    return viewMessages().filter(message => messageMatchesQuery(message, searchQuery()))
  })
  const activeSearchMessageId = createMemo(() => searchMatches()[searchIndex()]?.id)
  const descriptors = createMemo(() => buildChatRowDescriptors(
    renderMessages(),
    buildMessageLookups(viewMessages()),
    activeSearchMessageId(),
  ))
  // P57 S2-R3：items per-key 复用——descriptor 全字段相等时沿用上个 MessageListItem
  // 引用，PlainMessageList 的引用相等门随之跳过行 update 与测量失效。
  let lastItems: readonly MessageListItem[] = []
  const items = createMemo<readonly MessageListItem[]>(() => {
    const previousByKey = new Map(lastItems.map(item => [item.key, item]))
    const next = descriptors().map(descriptor => {
      const previous = previousByKey.get(descriptor.key)
      if (previous && isSameChatRowDescriptor(previous.descriptor, descriptor)) return previous
      return { key: descriptor.key, descriptor }
    })
    lastItems = next
    return next
  })
  const activityPlacement = createMemo(() => selectActivityTimelinePlacement(
    document(),
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
    const movingDown = viewport.scrollTop > lastObservedScrollTop
    lastObservedScrollTop = viewport.scrollTop
    syncScrollRail(viewport)
    // #212 S4：水合期忽略"到底/没到底"的瞬态翻转；用户显式上滚会立即结束水合
    // （cancelFollowForUserInput），因此这里不会吞掉真实输入。
    if (now() < hydratingUntil) return
    // P57 S1.3：锁判定改为「未到终点且未超时」——smooth 动画到达终点后位置判别
    // 即刻恢复（follow 回 true），锁过期后反馈不再被吞。
    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const distanceToEndpoint = Math.max(0, maxScroll - viewport.scrollTop)
    if (now() < followLockUntil && distanceToEndpoint > 0.5) return
    // P57 S1.1（R-C1）：写迹命中（|scrollTop - trace.top| ≤ 阈值）= 自己的程序化写入
    // 反馈——只刷 rail，不碰 followBottom、不清迹；否则按位置判别（现语义保留）。
    if (classifyScrollEvent(viewport.scrollTop, lastProgrammaticWrite, scrollTraceThresholdPx()) === 'programmatic-feedback') return
    // The 48px sticky band maintains following; it must not undo an explicit
    // upward gesture. Resume only on downward arrival at the actual endpoint
    // (1px allows integer scrollHeight/clientHeight vs fractional scrollTop).
    const atBottom = followBottom()
      ? distanceToEndpoint <= MESSAGE_LIST_BOTTOM_THRESHOLD_PX
      : movingDown && distanceToEndpoint <= 1
    if (!atBottom) lastAutoFollowTop = undefined
    setFollowBottom(atBottom)
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
    // ResizeObserver/content effects can request the same endpoint several
    // times in one stream tick. Avoid repeating an already-applied auto write;
    // repeated writes fight browser scroll anchoring and are perceived as
    // vertical jitter in a live reasoning stream. The first request is kept so
    // a newly mounted viewport still gets an explicit endpoint assignment.
    if (behavior === 'auto' && lastAutoFollowTop !== undefined
      && Math.abs(lastAutoFollowTop - top) <= 0.5
      && Math.abs(viewport.scrollTop - top) <= 0.5) {
      syncScrollRail(viewport)
      return
    }
    if (typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ top, behavior })
      // `scrollTo({ behavior: 'smooth' })` owns the animation.  Assigning
      // scrollTop immediately afterwards cancels that animation and produces
      // the visible jump reported during a live thinking stream.  For the
      // auto-follow path, retain the synchronous assignment only when the
      // endpoint actually differs (jsdom/test hosts often stub scrollTo).
      if (behavior === 'auto' && Math.abs(viewport.scrollTop - top) > 0.5) viewport.scrollTop = top
    } else {
      viewport.scrollTop = top
    }
    if (behavior === 'auto') {
      lastAutoFollowTop = top
      // P57 S1.1：程序化写入覆盖写迹；由此产生的 scroll 反馈事件经 classifyScrollEvent
      // 判为 programmatic-feedback，不再误关跟随。
      lastProgrammaticWrite = { top, at: now() }
    }
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
    // P57 S1.2：拖拽滚动条属用户输入——清迹、解除 smooth 守卫、作废排队写入。
    cancelFollowForUserInput()

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
    // P57 S1.2：轨道寻道属用户输入——同拖拽的取消语义；目标位置由 scroll 事件
    // 的位置判别自然落相位。
    cancelFollowForUserInput()
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
    // P57 S1.2（轨道键盘分支）：这是现存用户输入入口，各滚动分支同步按目标位置设
    // follow（End 例外 → 回底）；同步清迹并解除 smooth 守卫，锁定写入的反馈事件。
    beginScrollAction(Math.min(maxScroll, Math.max(0, target)) >= maxScroll - MESSAGE_LIST_BOTTOM_THRESHOLD_PX, 'auto')
    viewport.scrollTop = Math.min(maxScroll, Math.max(0, target))
    syncScrollRail(viewport)
  }

  const queueBottomFollow = () => {
    const revision = scrollActionRevision
    if (bottomFollowQueued) return
    bottomFollowQueued = true
    const applyFollow = () => {
      bottomFollowFrame = undefined
      bottomFollowQueued = false
      // P57 S1.3（R-C5）：smooth 跟随动画在途时，风暴中的 revision effect 不得
      // 写 instant 打断动画；守卫解除由 smooth watcher（到达判定）或用户取消路径。
      if (smoothInFlight) return
      if (revision !== scrollActionRevision || !followBottom()) return
      if (chatViewport) scrollViewportToBottom(chatViewport, 'auto')
    }
    // ResizeObserver/content effects can arrive several times before a paint.
    // Coalesce all of them into one endpoint write per frame; this prevents the
    // browser's scroll anchoring from fighting a microtask-per-character loop.
    if (typeof requestAnimationFrame === 'function') bottomFollowFrame = requestAnimationFrame(applyFollow)
    else queueMicrotask(applyFollow)
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
    lastObservedScrollTop = chatViewport?.scrollTop ?? 0
    followLockUntil = 0
    hydratingUntil = now() + HYDRATING_MS
    scrollActionRevision += 1
    setFollowBottom(true)
  })
  createEffect(() => {
    sessionId()
    const currentSnapshot = snapshot()
    // A new runtime revision is a fresh content opportunity even when the
    // computed bottom offset happens to be numerically identical (for example
    // jsdom or a fixed-height viewport).  Allow one follow write for it, while
    // still suppressing duplicate ResizeObserver callbacks for the same
    // revision.
    if (currentSnapshot.revision !== followedSnapshotRevision) {
      followedSnapshotRevision = currentSnapshot.revision
      lastAutoFollowTop = undefined
    }
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
      data-status={snapshot().status}
      data-creation-state={sessionCreation().phase}
      style={{
        '--right-panel-inset': `${Math.max(0, props.context.input().rightInset ?? 0)}px`,
        '--input-font-size': 'var(--chat-font-size)',
      }}
      aria-label="Solid Agent Workbench"
    >
      <Show
        when={props.context.input().sessionId}
        fallback={<div class="solid-workbench-chat-shell solid-workbench-empty-chat-shell" data-chat-viewport="empty">
          <div
            ref={node => { chatViewport = node }}
            class="chat-view solid-workbench-chat solid-workbench-empty-chat-viewport"
            data-chat-viewport="scroll"
            onScroll={event => updateBottomFollow(event.currentTarget)}
            onWheel={scrollIntent.onWheel}
            onTouchStart={scrollIntent.onTouchStart}
            onTouchMove={scrollIntent.onTouchMove}
            onTouchEnd={scrollIntent.onTouchEnd}
            onTouchCancel={scrollIntent.onTouchEnd}
            onKeyDown={scrollIntent.onKeyDown}
          >
            <div class="solid-workbench-empty-space">
              <WorkbenchEmptyBrand />
            </div>
          </div>
          <CreationOverlayHost
            visible={creationProgressVisible()}
            reducedMotion={props.context.input().reducedMotion === true}
          />
        </div>}
      >
        <div class="solid-workbench-chat-shell" data-chat-viewport="session">
          <div
            ref={node => { chatViewport = node }}
            class="chat-view solid-workbench-chat"
            data-chat-viewport="scroll"
            onScroll={event => updateBottomFollow(event.currentTarget)}
            onWheel={scrollIntent.onWheel}
            onTouchStart={scrollIntent.onTouchStart}
            onTouchMove={scrollIntent.onTouchMove}
            onTouchEnd={scrollIntent.onTouchEnd}
            onTouchCancel={scrollIntent.onTouchEnd}
            onKeyDown={scrollIntent.onKeyDown}
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
                rowLive={item => isAuthoritativelyLive(props.context, item.descriptor.renderMessage.message)}
                scrollViewport={() => chatViewport}
                scrollPosture={() => followBottom() ? 'follow' : 'pin'}
              />
              <WorkbenchDocumentSurface document={displayDocument()} context={props.context} commands={props.context.commands} sessionId={props.context.input().sessionId} reducedMotion={props.context.input().reducedMotion ?? false} />
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
          <CreationOverlayHost
            visible={creationProgressVisible()}
            reducedMotion={props.context.input().reducedMotion === true}
          />
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

/** Brand-only empty-state layer. The control center remains the sole input
 * surface; this block provides recognition without duplicating instructions,
 * context rows, or creation controls. */
function WorkbenchEmptyBrand() {
  const model = () => selectAgentEmptyState()
  return <div class="agent-empty-state solid-workbench-empty-brand" role="img" aria-label="Pylon Agent">
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

/** Creation feedback belongs to the chat viewport, not the control-center layout. */
function CreationOverlayHost(props: { visible: boolean; reducedMotion: boolean }) {
  return <div
    class="solid-workbench-creation-overlay-host"
    data-creation-overlay-host
    data-visible={props.visible ? 'true' : 'false'}
    data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
  >
    <Show when={props.visible}>
      <div class="solid-workbench-creation-progress" data-creation-progress role="status" aria-label="正在创建会话" aria-live="polite">
        <span class="solid-workbench-creation-progress-track" aria-hidden="true"><span class="solid-workbench-creation-progress-bar" /></span>
        <span class="solid-workbench-creation-progress-label">正在建立会话…</span>
      </div>
    </Show>
  </div>
}
