// @vitest-environment jsdom

/**
 * #221 高亮 DOM 生命周期的行为钉：视口外降级/恢复的几何一致、行 HTML 缓存命中与
 * 未命中、分帧高亮产物与直连高亮逐字节一致、帧预算调度配额与 urgent 插队、杀停开关。
 *
 * 环境成形：伪造 IntersectionObserver（真实 IO 在 jsdom 不存在 ⇒ 生产代码走「机制
 * 旁路」的现状时序，由既有测试套件覆盖；本文件 stub 后走 gated 路径），fake timers
 * 同步接管 setTimeout/requestAnimationFrame/performance，使观察回调、滞后带定时器
 * 与调度器让出全部确定性推进。高亮经 vi.mock 换成确定性行级假引擎，不依赖 wasm。
 */

import { cleanup, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHighlightScheduler,
  highlightLifecycleDisabledFor,
  type HighlightScheduler,
} from '../codeBlockDomLifecycle.ts'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'
import SolidCodeBlock from '../CodeBlock.solid.tsx'
import { highlightCode } from '../../../../components/chat/codeHighlight.ts'
import { sanitizeHtml } from '../../../../components/chat/htmlSanitizer.ts'

const highlightSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../../components/chat/codeHighlight.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../components/chat/codeHighlight.ts')>()
  return { ...actual, highlightCode: (...args: Parameters<typeof actual.highlightCode>) => highlightSpy(...args) }
})

/** 确定性假高亮：每行包一层带行号的 pl-* span，供「挂载产物」逐字节断言。 */
function fakeHighlightHtml(code: string): string {
  return code.split('\n')
    .map((line, index) => `<span class="pl-v" data-line="${index}">${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</span>`)
    .join('\n')
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  private readonly watched = new Map<Element, boolean>()

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.watched.set(target, false)
  }

  unobserve(target: Element): void {
    this.watched.delete(target)
  }

  disconnect(): void {
    this.watched.clear()
  }

  /** 手动驱动一次相交状态迁移（真实 IO 的异步首回调在测试里不需要）。 */
  emit(target: Element, isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }

  static emitTo(target: Element, isIntersecting: boolean): void {
    const instance = FakeIntersectionObserver.instances.find(observer => observer.watched.has(target))
    if (instance === undefined) throw new Error(`target not observed: ${target.className}`)
    instance.emit(target, isIntersecting)
  }
}

function lineSnapshots(root: HTMLDivElement) {
  return [...root.querySelectorAll<HTMLElement>('.term-code-line')].map(lineElement => {
    const text = lineElement.querySelector<HTMLElement>('.term-code-text')
    return {
      lineClass: lineElement.className,
      hasGutter: lineElement.querySelector('.term-code-gutter') !== null,
      textClass: text?.className,
      text: text?.textContent,
      innerHTML: text?.innerHTML,
      spanChildren: text?.querySelectorAll('span').length ?? 0,
    }
  })
}

beforeEach(() => {
  // 注意：instances 不清空——模块级 sharedObserver 缓存的 Fake 实例要跨测试存活，
  // emitTo 按「谁 watch 了这个 target」查找，释放过的旧实例自然失活。
  highlightSpy.mockImplementation(async (_language: string, code: string) => fakeHighlightHtml(code))
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'performance'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  highlightSpy.mockClear()
})

const FENCE_CODE = 'const alpha = 1\nbeta(alpha, 2)\n\nreturn alpha'
const FRAME_ADVANCE_MS = 200

async function mountMarkdownFence(): Promise<HTMLDivElement> {
  const mounted = render(() => <MarkdownContent text={'```js\n' + FENCE_CODE + '\n```'} />)
  await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)
  const root = mounted.container.querySelector<HTMLDivElement>('.term-code-block')
  expect(root).not.toBeNull()
  return root!
}

describe('#221 视口外降级/恢复（markdown 围栏路径）', () => {
  it('挂载即在圈外的块不高亮；进圈后经调度器恰好高亮一次', async () => {
    const root = await mountMarkdownFence()
    // 圈外：仍是纯文本行（fallback 分支），且从未发起高亮——历史重放级联消失的根。
    expect(highlightSpy).not.toHaveBeenCalled()
    for (const line of lineSnapshots(root)) {
      expect(line.spanChildren).toBe(0)
      expect(line.textClass).toBe('term-code-text')
    }
    FakeIntersectionObserver.emitTo(root, true)
    await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)
    expect(highlightSpy).toHaveBeenCalledTimes(1)
    expect(highlightSpy).toHaveBeenCalledWith('js', FENCE_CODE)
    expect(lineSnapshots(root).every(line => line.spanChildren === 1)).toBe(true)
  })

  it('降级/恢复几何一致：行数、类骨架、行文本不变；恢复产物与降级前逐字节一致且零重高亮', async () => {
    const root = await mountMarkdownFence()
    FakeIntersectionObserver.emitTo(root, true)
    await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)
    const highlighted = lineSnapshots(root)
    expect(highlighted).toHaveLength(4)
    expect(highlighted.every(line => line.spanChildren === 1 && line.hasGutter)).toBe(true)

    FakeIntersectionObserver.emitTo(root, false)
    await vi.advanceTimersByTimeAsync(600)
    const demoted = lineSnapshots(root)
    // 结构不变式：三层骨架与类名恒定；span 树清空、行文本原样保留（几何一致）。
    // 空行差异是既有约定：纯文本分支渲染 '\u00a0' 撑行高（与加载期 fallback 同口径），
    // 高亮分支空行是空 span——行高两侧由 line-height/min-height 恒定，字符层面归一化比对。
    const normalizePlaceholder = (text: string | undefined): string => (text === '\u00a0' ? '' : text ?? '')
    expect(demoted.map(line => line.lineClass)).toEqual(highlighted.map(line => line.lineClass))
    expect(demoted.map(line => line.hasGutter)).toEqual(highlighted.map(line => line.hasGutter))
    expect(demoted.map(line => line.textClass)).toEqual(highlighted.map(line => line.textClass))
    expect(demoted.map(line => normalizePlaceholder(line.text))).toEqual(highlighted.map(line => normalizePlaceholder(line.text)))
    expect(demoted.every(line => line.spanChildren === 0)).toBe(true)
    expect(highlightSpy).toHaveBeenCalledTimes(1)

    // 重进视口：缓存命中——产物逐字节还原，不发起第二次高亮。
    FakeIntersectionObserver.emitTo(root, true)
    await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)
    expect(lineSnapshots(root)).toEqual(highlighted)
    expect(highlightSpy).toHaveBeenCalledTimes(1)
  })

  it('分帧（调度器）产物与直连高亮逐行逐字节一致', async () => {
    const root = await mountMarkdownFence()
    FakeIntersectionObserver.emitTo(root, true)
    await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)

    const direct = await highlightCode('js', FENCE_CODE)
    const expectedLines = (direct ?? '').split('\n').map(line => sanitizeHtml(line || '&nbsp;'))
    const appliedLines = lineSnapshots(root).map(line => line.innerHTML)
    expect(appliedLines).toEqual(expectedLines)
  })
})

describe('#221 视口外降级/恢复（SolidCodeBlock 路径，#208 折叠共存）', () => {
  it('进圈高亮、出圈降级、重进恢复，全程恰好一次高亮', async () => {
    const mounted = render(() => (
      <SolidCodeBlock code={'let a = 1\nlet b = 2'} language="js" showLanguage={false} showCopyButton={false} />
    ))
    await vi.advanceTimersByTimeAsync(20)
    const root = mounted.container.querySelector<HTMLDivElement>('.term-code-block')
    expect(root).not.toBeNull()
    expect(highlightSpy).not.toHaveBeenCalled()

    FakeIntersectionObserver.emitTo(root!, true)
    await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)
    expect(highlightSpy).toHaveBeenCalledTimes(1)
    expect(lineSnapshots(root!).every(line => line.spanChildren === 1)).toBe(true)

    FakeIntersectionObserver.emitTo(root!, false)
    await vi.advanceTimersByTimeAsync(600)
    expect(lineSnapshots(root!).every(line => line.spanChildren === 0)).toBe(true)

    FakeIntersectionObserver.emitTo(root!, true)
    await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)
    expect(lineSnapshots(root!).every(line => line.spanChildren === 1)).toBe(true)
    expect(highlightSpy).toHaveBeenCalledTimes(1)
  })

  it('#208 步进展开（visibleCode 前进）使缓存失配：圈内重取新可见代码', async () => {
    const [code, setCode] = createSignal('let a = 1\nlet b = 2')
    const mounted = render(() => (
      <SolidCodeBlock code={code()} language="js" showLanguage={false} showCopyButton={false} />
    ))
    await vi.advanceTimersByTimeAsync(20)
    const root = mounted.container.querySelector<HTMLDivElement>('.term-code-block')!
    FakeIntersectionObserver.emitTo(root, true)
    await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)
    expect(highlightSpy).toHaveBeenCalledTimes(1)
    expect(highlightSpy).toHaveBeenLastCalledWith('js', 'let a = 1\nlet b = 2')

    // 圈内展开步进：代码前进 → 缓存失配 → 重取；在途/过期结果由缓存键守卫丢弃。
    setCode('let a = 1\nlet b = 2\nlet c = 3')
    await vi.advanceTimersByTimeAsync(FRAME_ADVANCE_MS)
    expect(highlightSpy).toHaveBeenCalledTimes(2)
    expect(highlightSpy).toHaveBeenLastCalledWith('js', 'let a = 1\nlet b = 2\nlet c = 3')
    expect(lineSnapshots(root).every(line => line.spanChildren === 1)).toBe(true)
  })
})

describe('#221 帧预算调度器（注入时钟/让出的确定性单元）', () => {
  interface SchedulerHarness {
    scheduler: HighlightScheduler
    yields(): number
    clock: { value: number }
  }

  function makeScheduler(budgetMs = 10): SchedulerHarness {
    const clock = { value: 0 }
    let yieldCount = 0
    const scheduler = createHighlightScheduler({
      budgetMs,
      now: () => clock.value,
      yieldToNextFrame: continuation => {
        yieldCount += 1
        clock.value = yieldCount * 100
        continuation()
      },
    })
    return { scheduler, yields: () => yieldCount, clock }
  }

  it('同帧作业按结算耗时累计，超预算让出到下一帧（6ms/作业、10ms 预算 → 3 帧）', async () => {
    const { scheduler, yields, clock } = makeScheduler()
    const order: number[] = []
    for (let index = 0; index < 5; index += 1) {
      scheduler.schedule(async () => {
        clock.value += 6
        order.push(index)
      })
    }
    await vi.waitFor(() => expect(order).toEqual([0, 1, 2, 3, 4]))
    expect(yields()).toBe(3)
  })

  it('urgent 插队：用户正在看的恢复先于排队的普通作业', async () => {
    const { scheduler } = makeScheduler()
    const order: string[] = []
    scheduler.schedule(async () => { order.push('plain-a') })
    scheduler.schedule(async () => { order.push('plain-b') })
    scheduler.schedule(async () => { order.push('urgent') }, true)
    await vi.waitFor(() => expect(order).toEqual(['plain-a', 'urgent', 'plain-b']))
  })
})

describe('#221 杀停开关', () => {
  it('祖先带 data-highlight-lifecycle="off" 时判定禁用', () => {
    const outer = document.createElement('div')
    outer.setAttribute('data-highlight-lifecycle', 'off')
    const inner = document.createElement('div')
    outer.appendChild(inner)
    document.body.appendChild(outer)
    try {
      expect(highlightLifecycleDisabledFor(inner)).toBe(true)
      expect(highlightLifecycleDisabledFor(document.body)).toBe(false)
    } finally {
      outer.remove()
    }
  })
})
