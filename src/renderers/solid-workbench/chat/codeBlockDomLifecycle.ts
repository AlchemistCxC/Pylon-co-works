// #221 高亮 DOM 生命周期：共享视口观察器（滞后带降级）+ 帧预算高亮调度器。
//
// 内存主诉：完成代码块的 token-per-span 树全会话周期常驻。本模块提供两件机械：
// 1. `trackCodeBlockVisibility`——单例 IntersectionObserver（rootMargin 上下各一屏），
//    出圈后每块独立 500ms 延迟才宣布 onExit（滞后带，重进即取消），进圈立即 onEnter。
//    消费方（两个 CodeBlock 组件）据此把 span 树降级为纯文本行，行 HTML 字符串留在
//    JS（降一个数量级），重进视口先走缓存恢复、未命中再走调度器重高亮。
// 2. `scheduleHighlightJob`——帧预算串行调度器：作业是「高亮 → 应用」的完整异步单元，
//    前一作业结算后才计下一作业的耗时（wasm `highlightBlock` 是同步整块出口，其成本
//    因此计入预算）；每帧预算 8ms，帧间让出。历史重放/会话切换的级联高亮由「圈外块
//    根本不发起」+「每帧配额」双重摊销；用户正在看的恢复走 urgent 插队。
//
// 特性检测契约：宿主无 IntersectionObserver（jsdom/旧内核）⇒ 两个入口都给出「机制
// 旁路」的返回形态，组件保持与引入本模块前逐字节相同的时序——既有行为测试零修改。
// 禁区：本模块不做 sanitize、不碰 DOM 内容；`highlightCode` 的 provider 契约（#221
// 约束）与计算核「整块进、行数组出」边界（#220 裁决）零接触。

export interface CodeBlockVisibilityCallbacks {
  /** 块进入视口余量（含挂载即可见的首个观察回调）。 */
  onEnter(): void
  /** 块离开视口余量且滞后带耗尽。 */
  onExit(): void
}

export interface CodeBlockVisibilityHandle {
  release(): void
}

/** 杀停开关：任意祖先带 `data-highlight-lifecycle="off"` 时跳过整套机制（回滚用）。 */
export function highlightLifecycleDisabledFor(element: HTMLElement): boolean {
  return element.closest('[data-highlight-lifecycle="off"]') !== null
}

interface BlockEntry {
  onEnter(): void
  onExit(): void
  inside: boolean
  demoteTimer?: number
}

let sharedObserver: IntersectionObserver | undefined
const trackedBlocks = new WeakMap<Element, BlockEntry>()

function ensureSharedObserver(): IntersectionObserver {
  sharedObserver ??= new IntersectionObserver(observerList => {
    for (const record of observerList) {
      const entry = trackedBlocks.get(record.target)
      if (entry === undefined || record.isIntersecting === entry.inside) continue
      entry.inside = record.isIntersecting
      if (record.isIntersecting) {
        if (entry.demoteTimer !== undefined) {
          window.clearTimeout(entry.demoteTimer)
          entry.demoteTimer = undefined
        }
        entry.onEnter()
      } else {
        // 滞后带：滚动掠过的块不立刻降级，500ms 后仍出圈才动 DOM。
        entry.demoteTimer = window.setTimeout(() => {
          entry.demoteTimer = undefined
          if (!entry.inside) entry.onExit()
        }, 500)
      }
    }
  }, { rootMargin: '100% 0px' })
  return sharedObserver
}

export function trackCodeBlockVisibility(
  element: HTMLElement | undefined,
  callbacks: CodeBlockVisibilityCallbacks,
): CodeBlockVisibilityHandle | undefined {
  if (element === undefined || typeof IntersectionObserver === 'undefined') return undefined
  if (highlightLifecycleDisabledFor(element)) return undefined
  const entry: BlockEntry = { ...callbacks, inside: false }
  trackedBlocks.set(element, entry)
  ensureSharedObserver().observe(element)
  return {
    release() {
      if (entry.demoteTimer !== undefined) window.clearTimeout(entry.demoteTimer)
      trackedBlocks.delete(element)
      sharedObserver?.unobserve(element)
    },
  }
}

// ─── 帧预算调度器 ────────────────────────────────────────────────────────────

export type HighlightJob = () => Promise<void>

export interface HighlightScheduler {
  schedule(job: HighlightJob, urgent?: boolean): void
  /** 测试与诊断用：当前尚未开跑的排队作业数。 */
  pendingCount(): number
}

export interface HighlightSchedulerOptions {
  /** 单帧内允许作业结算占用的毫秒预算。 */
  budgetMs: number
  now(): number
  yieldToNextFrame(continuation: () => void): void
}

/**
 * 作业串行是预算可信的前提：只有等上一个作业结算后再看钟，才把它的成本计入帧预算。
 *
 * #241 刀6 起这条前提的两半都变了：引擎不再是 wasm（是前端 Lezer），且**解析自身**也会按时间
 * 切片、片间让出主线程（`lezerHighlight.ts` 的 `parseWholeDocument`）。于是这里「本帧预算是否
 * 用尽」的判据从「同步算力」变成了「作业是否已结算」——巨块作业会横跨若干帧，但它在帧内并不
 * 独占主线程，故本调度器不需要（也不应该）按墙钟时长去打断或放弃作业：让出交给引擎，
 * 本层继续负责**作业顺序**与**谁先发**。
 */
export function createHighlightScheduler(options: HighlightSchedulerOptions): HighlightScheduler {
  const queue: HighlightJob[] = []
  let pumping = false

  const pump = (): void => {
    if (pumping) return
    pumping = true
    const step = (): void => {
      void (async () => {
        const frameDeadline = options.now() + options.budgetMs
        while (queue.length > 0) {
          const job = queue.shift()!
          try {
            await job()
          } catch {
            // 作业内部自兜底（高亮失败按 null 口径落地）；这里保调度器自身不红。
          }
          if (options.now() >= frameDeadline) break
        }
        if (queue.length > 0) options.yieldToNextFrame(step)
        else pumping = false
      })()
    }
    options.yieldToNextFrame(step)
  }

  return {
    schedule(job, urgent = false) {
      if (urgent) queue.unshift(job)
      else queue.push(job)
      pump()
    },
    pendingCount: () => queue.length,
  }
}

/** 产品单例：8ms 帧预算，rAF 让出（宿主缺失时 setTimeout 16ms 兜底）。 */
const productScheduler = createHighlightScheduler({
  budgetMs: 8,
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  yieldToNextFrame: continuation => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => continuation())
    else window.setTimeout(continuation, 16)
  },
})

export function scheduleHighlightJob(job: HighlightJob, urgent = false): void {
  productScheduler.schedule(job, urgent)
}
