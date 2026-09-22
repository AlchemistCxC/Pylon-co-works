// @vitest-environment jsdom
import { render, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRowDescriptor } from '../../../../components/chat/chatRowPipeline.ts'
import { toRenderMessage, type Message } from '../../../../components/chat/messageTypes.ts'
import { createMessageListItems, type MessageListItem, type MessageListPort } from '../../../../domains/workbench/messageListPort.ts'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel, peekMarkdownRenderModel } from '../markdownRenderModel.ts'
import { markdownParseCounters } from '../markdownParseCounters.ts'
import { PlainMessageList } from '../PlainMessageList.solid.tsx'

function descriptor(message: Message): ChatRowDescriptor {
  return {
    key: message.id,
    renderMessage: toRenderMessage(message),
    showConnector: false,
    isSearchMatch: false,
  }
}

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }
  emit() {
    this.callback([], this as unknown as ResizeObserver)
  }
  unobserve = vi.fn()
}

beforeEach(() => {
  ResizeObserverMock.instances = []
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 视口 300px、scrollTop 可写的真实滚动容器（引擎的坐标基准）。 */
function mountScroller() {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  let scrollTop = 0
  Object.defineProperty(scroller, 'offsetHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop, set: (value: number) => { scrollTop = value }, configurable: true,
  })
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 100, width: 100, height: 300, x: 0, y: 0, toJSON() {} })
  // jsdom 无布局：引擎的 getMaxScrollOffset = scrollHeight - clientHeight，缺桩会把
  // scrollToIndex 的目标偏移钳制到 0
  Object.defineProperty(scroller, 'scrollHeight', { value: 100_000, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
  scroller.scrollTo = ((options: { top?: number }) => {
    scrollTop = options.top ?? 0
    scroller.dispatchEvent(new Event('scroll'))
  }) as unknown as typeof scroller.scrollTo
  return {
    scroller,
    jumpTo: (value: number) => {
      scrollTop = value
      scroller.dispatchEvent(new Event('scroll'))
    },
  }
}

function makeItems(prefix: string, count: number, content: string): MessageListItem[] {
  return createMessageListItems(Array.from({ length: count }, (_, index) => descriptor({
    id: `${prefix}${index}`, role: 'assistant', sender: 'agent', content: `${content} ${index}`, time: '10:00',
  })))
}

/** 物化行数上界：视口 300px / 估算 76px ≈ 4 行，上下 overscan 各 8 ⇒ 24 是宽松上界。 */
const MATERIALIZED_BOUND = 24

describe('PlainMessageList #243 行虚拟化', () => {
  it('验收：1000 行会话下物化行 ≤ 视口 + overscan，其余行为占位盒', async () => {
    const { scroller, jumpTo } = mountScroller()
    let port!: MessageListPort
    const result = render(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }} renderItem={item => item.key}
      />
    ), { container: scroller })
    const ids = () => result.container.querySelectorAll('[data-message-id]')
    port.setItems(makeItems('m', 1000, 'row'))
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))

    jumpTo(999999) // 上层贴底姿态钉底
    await waitFor(() => expect([...ids()].at(-1)?.getAttribute('data-message-id')).toBe('m999'))
    expect(ids().length).toBeLessThanOrEqual(MATERIALIZED_BOUND)
    // 窗外行不驻留 DOM：总节点 = 窗内行；几何由容器 spacer（内联 padding）承载
    const list = result.container.querySelector<HTMLElement>('[data-message-list="plain"]')!
    expect(list.style.paddingBottom).toMatch(/px$/)
  })

  it('窗外行不驻留 DOM，几何由容器 spacer 承载；滚回即重物化', async () => {
    const { scroller, jumpTo } = mountScroller()
    let port!: MessageListPort
    const result = render(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }} renderItem={item => item.key}
      />
    ), { container: scroller })
    port.setItems(makeItems('m', 500, 'row'))
    await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))

    // scrollTop=0 ⇒ 头部窗口物化；spacer 以内联 padding 承载窗外几何
    const list = result.container.querySelector<HTMLElement>('[data-message-list="plain"]')!
    expect(list.style.paddingTop).toMatch(/px$/)
    expect(result.container.querySelector('[data-message-id="m0"]')).not.toBeNull()

    // 跳到尾部：m0 卸载（窗外不驻留 DOM）；再回首部：重物化
    jumpTo(999999)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m499"]')).not.toBeNull())
    expect(result.container.querySelector('[data-message-id="m0"]')).toBeNull()
    jumpTo(0)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m0"]')).not.toBeNull())
  })

  it('D3 双阈值（取「与」）：行多字少不启用；行多字多自动启用', async () => {
    const lightScroller = mountScroller()
    // 300 行 × ~7 字符 = 远低于 100k 字符门槛 ⇒ 不启用（legacy 整挂路径）
    const light = render(() => (
      <PlainMessageList initialItems={makeItems('a', 300, 'row')} virtualization="auto"
        scrollViewport={() => lightScroller.scroller} renderItem={item => item.key} />
    ), { container: lightScroller.scroller })
    expect(light.container.querySelectorAll('[data-row-placeholder]')).toHaveLength(0)
    expect(light.container.querySelectorAll('[data-message-id]')).toHaveLength(300)

    // 300 行 × 420 字符 ≈ 126k 字符 ≥ 门槛 ⇒ 自动启用
    const heavyScroller = mountScroller()
    const heavy = render(() => (
      <PlainMessageList initialItems={makeItems('b', 300, 'x'.repeat(420))} virtualization="auto"
        scrollViewport={() => heavyScroller.scroller} renderItem={item => item.key} />
    ), { container: heavyScroller.scroller })
    await waitFor(() => expect(heavy.container.querySelectorAll('[data-message-id]').length).toBeLessThanOrEqual(MATERIALIZED_BOUND))
    expect(Number(heavy.container.querySelectorAll('[data-message-id]').length)).toBeGreaterThan(0)
  })

  it('杀停开关：祖先带 data-row-virtualization="off" 时整挂（#221 先例形态）', async () => {
    const { scroller } = mountScroller()
    const host = document.createElement('div')
    host.setAttribute('data-row-virtualization', 'off')
    document.body.append(host)
    const result = render(() => (
      <PlainMessageList initialItems={makeItems('m', 500, 'row')} virtualization="on"
        scrollViewport={() => scroller} renderItem={item => item.key} />
    ), { container: host })
    await Promise.resolve()
    expect(result.container.querySelectorAll('[data-message-id]')).toHaveLength(500)
    expect(result.container.querySelectorAll('[data-row-placeholder]')).toHaveLength(0)
  })

  it('scrollTo 命中占位区：只物化目标附近（不再全开），返回 true', async () => {
    const { scroller } = mountScroller()
    let port!: MessageListPort
    const result = render(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }} renderItem={item => item.key}
      />
    ), { container: scroller })
    port.setItems(makeItems('m', 1000, 'row'))
    await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))

    const hit = await port.scrollTo({ messageId: 'm600', align: 'start' })
    expect(hit).toBe(true)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m600"]')).not.toBeNull())
    expect(result.container.querySelectorAll('[data-message-id]').length).toBeLessThanOrEqual(MATERIALIZED_BOUND)
    expect(result.container.querySelector('[data-message-id="m0"]')).toBeNull()
  })

  it('虚拟化下持续物化的行跨 setItems 保持 DOM 身份（P57 S2-R3 不因虚拟化松动）', async () => {
    const { scroller } = mountScroller()
    let port!: MessageListPort
    const result = render(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ), { container: scroller })
    port.setItems(makeItems('m', 500, 'row'))
    await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))

    // 记住当前在窗内的一个行节点，原引用喂入内容更新 ⇒ 节点引用必须不变
    ;(globalThis as { __probeTag?: string }).__probeTag = 'first-mount'
    const stable = result.container.querySelector('[data-message-id="m0"]')
    if (stable === null) {
      // m0 可能不在初始窗内（窗锚在头部的 scrollTop=0 起点必含 m0）——此处必在
      throw new Error('m0 应在初始窗内')
    }
    const items = makeItems('m', 500, 'row')
    const updatedDescriptor = descriptor({
      ...items[0]!.descriptor.renderMessage.message,
      content: 'row 0 updated',
    })
    ;(globalThis as { __probeTag?: string }).__probeTag = 'before-update'
    port.setItems([{ key: updatedDescriptor.key, descriptor: updatedDescriptor }, ...items.slice(1)])
    ;(globalThis as { __probeTag?: string }).__probeTag = 'after-update'
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m0"]')).toHaveTextContent('row 0 updated'))
    expect(result.container.querySelector('[data-message-id="m0"]')).toBe(stable)
  })

  it('#243 切片4：行卸载后再挂载不重解析（markdown LRU 计数证明，D7 改口径②）', async () => {
    clearMarkdownRenderModelCache()
    const { scroller, jumpTo } = mountScroller()
    let port!: MessageListPort
    // 全部行共享同一 markdown 串 ⇒ LRU 里只有一条目：任何重挂载若走解析即计 parsed+1，
    // 走缓存即计 cacheHits+1——往返一趟后 parsed 零增长就是「不重解析」的计数证明。
    const mdContent = '# 共享标题\n\n共享正文段落'
    const result = render(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }}
        renderItem={item => {
          void getMarkdownRenderModel(mdContent)
          return <span>{item.descriptor.renderMessage.message.id}</span>
        }}
      />
    ), { container: scroller })
    port.setItems(makeItems('m', 500, 'row'))
    await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))
    // 等首解析落地
    await waitFor(() => expect(peekMarkdownRenderModel(mdContent) !== undefined).toBe(true))

    const baseline = markdownParseCounters()
    // 滚到尾部：m0 卸载；再回首部：m0 重挂载
    jumpTo(999999)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m499"]')).not.toBeNull())
    jumpTo(0)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m0"]')).not.toBeNull())

    const after = markdownParseCounters()
    expect(after.parsed).toBe(baseline.parsed) // 重挂载零解析
    expect(after.cacheHits).toBeGreaterThan(baseline.cacheHits) // 命中 LRU
  })
})
