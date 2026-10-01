/**
 * 聊天滚动跟随控制器（#486 项4 自 WorkbenchContent.solid.tsx 拆出的状态机模块；
 * 行为不变——P57 S1.x / #212 S4 的锁、写迹、smooth 守卫与轨道交互逐段原样搬移）。
 *
 * 职责：吸底跟随判定（用户意图 vs 程序化写入反馈）、回底排队与去重、滚动条轨道
 * 拖拽/寻道/键盘寻道、rail 几何度量，以及「会话切换重置」「内容 revision 触发回底」
 * 两个 effect。消息投影与行渲染留在组件里。
 *
 * 必须在组件作用域内调用（内部使用 createEffect / createSignal / onCleanup）。
 */
import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { MESSAGE_LIST_BOTTOM_THRESHOLD_PX } from '../../../domains/workbench/messageViewportState.ts'
import { classifyScrollEvent, HYDRATING_MS, INSTANT_LOCK_MS, scrollTraceThreshold, SMOOTH_LOCK_MS, type ScrollWriteTrace } from '../../../domains/chat/scrollFollowModel.ts'
import { createScrollUserIntent } from '../../../domains/chat/scrollUserIntent.ts'

export interface ChatScrollControllerOptions {
  /** 会话身份（切换时重置跟随相位）。 */
  readonly sessionId: () => string | null | undefined
  /** 运行时快照 revision（新内容机会去重）。 */
  readonly snapshotRevision: () => number | undefined
  /** 降级动效（回顶/回底用 instant 还是 smooth）。 */
  readonly reducedMotion: () => boolean | undefined
}

export interface ScrollRailMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  trackHeight: number
}

export interface ChatScrollController {
  readonly followBottom: () => boolean
  /** 当前视口（ref 由组件接线注入；未挂载为 undefined）。 */
  readonly viewport: () => HTMLDivElement | undefined
  readonly scrollRailMetrics: () => ScrollRailMetrics
  readonly scrollRailThumb: () => { visible: boolean; height: number; offset: number; maxScroll: number }
  readonly scrollIntent: ReturnType<typeof createScrollUserIntent>
  readonly registerViewport: (node: HTMLDivElement) => void
  readonly registerContent: (node: HTMLDivElement) => void
  readonly registerScrollRailTrack: (node: HTMLDivElement) => void
  readonly onViewportScroll: (event: Event & { currentTarget: EventTarget & HTMLDivElement }) => void
  readonly onContentResize: () => void
  readonly scrollToTop: (event?: Event) => void
  readonly resumeBottomFollow: (event?: Event) => void
  readonly seekScrollRailTrack: (event: MouseEvent | PointerEvent) => void
  readonly handleScrollRailKeyDown: (event: KeyboardEvent) => void
  readonly beginScrollRailThumbDrag: (event: PointerEvent) => void
}

export function createChatScrollController(options: ChatScrollControllerOptions): ChatScrollController {
  const [followBottom, setFollowBottom] = createSignal(true)
  let chatViewport: HTMLDivElement | undefined
  let chatContent: HTMLDivElement | undefined
  let scrollRailTrack: HTMLDivElement | undefined
  let stopScrollRailDrag: (() => void) | undefined
  const [scrollRailMetrics, setScrollRailMetrics] = createSignal<ScrollRailMetrics>({
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
  })

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
    const behavior = options.reducedMotion() ? 'auto' : 'smooth'
    beginScrollAction(false, behavior)
    if (typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ top: 0, behavior })
    } else {
      viewport.scrollTop = 0
    }
  }

  createEffect(() => {
    const id = options.sessionId()
    if (id === followedSessionId) return
    followedSessionId = id
    lastObservedScrollTop = chatViewport?.scrollTop ?? 0
    followLockUntil = 0
    hydratingUntil = now() + HYDRATING_MS
    scrollActionRevision += 1
    setFollowBottom(true)
  })
  createEffect(() => {
    options.sessionId()
    const revision = options.snapshotRevision()
    // A new runtime revision is a fresh content opportunity even when the
    // computed bottom offset happens to be numerically identical (for example
    // jsdom or a fixed-height viewport).  Allow one follow write for it, while
    // still suppressing duplicate ResizeObserver callbacks for the same
    // revision.
    if (revision !== followedSnapshotRevision) {
      followedSnapshotRevision = revision
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
    const behavior = options.reducedMotion() ? 'auto' : 'smooth'
    beginScrollAction(true, behavior)
    const viewport = viewportFromAction(event)
    if (viewport) scrollViewportToBottom(viewport, behavior)
  }

  return {
    followBottom,
    viewport: () => chatViewport,
    scrollRailMetrics,
    scrollRailThumb,
    scrollIntent,
    registerViewport: node => { chatViewport = node },
    registerContent: node => { chatContent = node },
    registerScrollRailTrack: node => { scrollRailTrack = node },
    onViewportScroll: event => updateBottomFollow(event.currentTarget),
    onContentResize: () => {
      syncScrollRail()
      if (!followBottom()) return
      queueBottomFollow()
    },
    scrollToTop,
    resumeBottomFollow,
    seekScrollRailTrack,
    handleScrollRailKeyDown,
    beginScrollRailThumbDrag,
  }
}
