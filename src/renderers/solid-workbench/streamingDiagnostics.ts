/**
 * 流式显示调度器的真机诊断读数（台账 P89 / 施工书 S0，纯观测，不改行为）。
 *
 * 两件事：
 * 1. `diagnoseStreamingRows()`：读当前消息行的几何（行宽/正文宽/标记列宽/实际渲染行数），
 *    用于当场判定"是宽度塌陷还是内容里多了硬换行"（P86 家族症状的判据）。
 * 2. 成本读数与读数登记：把调度器 counters + 发布耗时 + 行几何打包成只读读数，
 *    经 `rendererDiagnosticsRegistry` 由验收桥按需拉取（不新增全局、不新增协议）。
 */
import type { StreamingDisplayDiagnosticsSnapshot } from './streamingDisplayScheduler.ts'
import { streamingRowCounters } from './chat/streamingRowCounters.ts'
import { registerRendererDiagnostics } from '../../plugin-runtime/renderers/rendererDiagnosticsRegistry.ts'

/** 验收桥上的读数 key（`__PYLON_KERNEL_DEV__.diagnostics.read('streamingDisplay')`）。 */
export const STREAMING_DISPLAY_DIAGNOSTICS_KEY = 'streamingDisplay'

export interface StreamingRowGeometry {
  /** 行所属消息 id（取自消息行包装元素的 data-message-id） */
  readonly messageId: string
  readonly role: 'assistant' | 'reasoning'
  /** 消息行元素宽度（px） */
  readonly rowWidth: number
  /** 正文元素宽度（px）；≈0 或远小于 rowWidth 即"宽度塌陷" */
  readonly bodyWidth: number
  /** 助手标记列宽度（px）；无标记时为 0 */
  readonly markerWidth: number
  /** 正文实际渲染行数（Range.getClientRects().length） */
  readonly textLines: number
  /**
   * 该行渲染出的顶层块数（读取时剥掉 slot/kind/collapse 包装层）。
   * 行集合是当前文本的函数，因此它不应超过该行的文本段落数。
   */
  readonly blocks: number
  /** 其中不足 6 字的块数——issue #55「每几个字换行」的现场判据（健康值 0） */
  readonly tinyRows: number
}

/** “碎裂”判据的阈值：一个渲染块只有不到 6 个字就换行（与 issue #55 的现场取证口径一致）。 */
const TINY_BLOCK_MAX_LENGTH = 6

/** 生产 DOM 里正文外还有 slot / kind / collapse 包装层，行元素挂在最内层再往下就不是包装层处。 */
const CONTENT_WRAPPER_CLASSES = ['solid-renderer-slot-host', 'solid-content-kind', 'term-collapse', 'term-collapse-content']

function isContentWrapper(element: Element): boolean {
  return CONTENT_WRAPPER_CLASSES.some(className => element.classList.contains(className))
}

/** 向下走过「唯一子节点且是包装层」的链，回到真正承载行元素的那一层。 */
function contentRoot(body: HTMLElement): HTMLElement {
  let node = body
  while (node.children.length === 1) {
    const only = node.children.item(0)
    if (!(only instanceof HTMLElement) || !isContentWrapper(only)) break
    node = only
  }
  return node
}

/**
 * 读当前挂载体内流式行的几何。**只读**，不做任何 DOM 写入。
 * 注意：jsdom 里没有布局，几何值恒为 0；真实数值只能在真浏览器取得（CDP 探针）。
 */
export function diagnoseStreamingRows(host: HTMLElement): readonly StreamingRowGeometry[] {
  const rows = resolveRowScope(host).scope.querySelectorAll<HTMLElement>(ROW_SELECTOR)
  const geometry: StreamingRowGeometry[] = []
  rows.forEach(row => {
    const body = row.querySelector<HTMLElement>('.term-assistant-body, .term-reasoning-body')
    if (body === null) return
    const marker = row.querySelector<HTMLElement>('.term-assistant-dot, .term-assistant-dot-img')
    const blocks = countBlocks(body)
    geometry.push({
      messageId: row.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '',
      role: row.classList.contains('term-row-assistant') ? 'assistant' : 'reasoning',
      rowWidth: roundWidth(row.getBoundingClientRect().width),
      bodyWidth: roundWidth(body.getBoundingClientRect().width),
      markerWidth: marker === null ? 0 : roundWidth(marker.getBoundingClientRect().width),
      textLines: countTextLines(body),
      blocks: blocks.length,
      tinyRows: blocks.tiny,
    })
  })
  return geometry
}

/** 发布耗时读数（S5a 只读；用于"这个机器扛不扛得住当前节奏"的现场判断）。 */
export interface StreamingDisplayPublishCost {
  readonly samples: number
  readonly lastMs: number
  readonly maxMs: number
  readonly p95Ms: number
}

export interface StreamingDisplayPublishCostRecorder {
  record(durationMs: number): void
  snapshot(): StreamingDisplayPublishCost
}

/** 发布耗时环形记录器（固定容量，O(1) 记录）。 */
export function createStreamingDisplayPublishCostRecorder(capacity = 64): StreamingDisplayPublishCostRecorder {
  const samples: number[] = []
  let cursor = 0
  let last = 0
  return {
    record(durationMs: number) {
      const value = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
      last = value
      if (samples.length < capacity) samples.push(value)
      else {
        samples[cursor] = value
        cursor = (cursor + 1) % capacity
      }
    },
    snapshot(): StreamingDisplayPublishCost {
      if (samples.length === 0) return { samples: 0, lastMs: 0, maxMs: 0, p95Ms: 0 }
      const ordered = [...samples].sort((a, b) => a - b)
      return {
        samples: samples.length,
        lastMs: last,
        maxMs: ordered.at(-1) ?? 0,
        p95Ms: ordered[Math.min(ordered.length - 1, Math.floor(0.95 * ordered.length))],
      }
    },
  }
}

/** 登记流式显示读数；返回注销函数（挂载层在 destroy 时调用）。 */
export function registerStreamingDisplayDiagnostics(input: {
  host: HTMLElement
  scheduler: { diagnostics(): StreamingDisplayDiagnosticsSnapshot }
  publishCost: StreamingDisplayPublishCostRecorder
}): () => void {
  return registerRendererDiagnostics(STREAMING_DISPLAY_DIAGNOSTICS_KEY, () => JSON.stringify({
    snapshot: input.scheduler.diagnostics(),
    publishCost: input.publishCost.snapshot(),
    // 行集合的规模读数（纯观测）：rows / textParagraphs > 1 即出现文本之外的边界。
    rowSet: streamingRowCounters(),
    // 实际用的行读取作用域（多 workbench 挂载时注册 host 可能不含当前会话的行）。
    rowScope: resolveRowScope(input.host).scopeName,
    rows: diagnoseStreamingRows(input.host),
  }))
}

const ROW_SELECTOR = '.term-row-assistant, .term-row-reasoning'

/**
 * 行的读取作用域：host 里有行就用 host，否则回退到文档。
 *
 * 为什么需要回退（issue #55 真机实测）：读数以**全局 key** 注册，而同一个应用可能挂载多个
 * workbench（例如设置里的预览 workbench），后注册者会覆盖前一个；若它的 host 不含当前会话的
 * 消息行，`rows` 就会恒为空（真机现场正是如此，而 document 里明明有 19 个行元素）。
 * 回退后读数总能取到真实行，并对外报告实际作用域（`rowScope`）供判读。
 */
function resolveRowScope(host: HTMLElement): { scope: ParentNode; scopeName: 'host' | 'document' } {
  if (host.querySelector(ROW_SELECTOR) !== null) return { scope: host, scopeName: 'host' }
  const fallback = host.ownerDocument
  return fallback === null ? { scope: host, scopeName: 'host' } : { scope: fallback, scopeName: 'document' }
}

/** 行集合规模：顶层块总数与其中的“小块”数（读取不修改任何状态）。 */function countBlocks(body: HTMLElement): { length: number; tiny: number } {
  const children = contentRoot(body).children
  let tiny = 0
  for (const child of children) {
    const length = (child.textContent ?? '').length
    if (length > 0 && length < TINY_BLOCK_MAX_LENGTH) tiny += 1
  }
  return { length: children.length, tiny }
}

function roundWidth(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

function countTextLines(element: HTMLElement): number {
  // jsdom 不实现 Range 几何：真实行数只在真浏览器可得，取不到就回 0（不报错）。
  try {
    const range = document.createRange()
    range.selectNodeContents(element)
    return range.getClientRects().length
  } catch {
    return 0
  }
}
