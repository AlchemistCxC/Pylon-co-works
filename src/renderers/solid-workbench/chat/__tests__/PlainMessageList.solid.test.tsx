// @vitest-environment jsdom
import { render, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRowDescriptor } from '../../../../components/chat/chatRowPipeline.ts'
import { toRenderMessage, type Message } from '../../../../components/chat/messageTypes.ts'
import { createMessageListItems, type MessageListItem, type MessageListPort } from '../../../../domains/workbench/messageListPort.ts'
import { PlainMessageList } from '../PlainMessageList.solid.tsx'

function descriptor(message: Message): ChatRowDescriptor {
  return {
    key: message.id,
    renderMessage: toRenderMessage(message),
    showConnector: false,
    isSearchMatch: false,
  }
}

const ITEMS = createMessageListItems([
  descriptor({ id: 'm1', role: 'user', sender: 'user', content: 'one', time: '10:00' }),
  descriptor({ id: 'm2', role: 'assistant', sender: 'agent', content: 'two', time: '10:01' }),
])

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

describe('PlainMessageList', () => {
  it('does not revisit keys when the immutable input array is unchanged', () => {
    let reads = 0
    const items = ITEMS.map(item => ({ get key() { reads++; return item.key }, descriptor: item.descriptor }))
    let port!: MessageListPort
    render(() => <PlainMessageList initialItems={items} onPortReady={value => { port = value }} renderItem={item => item.key} />)
    const before = reads
    for (let index = 0; index < 10; index++) port.setItems(items)
    expect(reads).toBe(before)
  })

  it('keeps row identity and content across reordering, insertion and trimming', () => {
    let port!: MessageListPort
    const result = render(() => <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }}
      renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>} />)
    const original = result.container.querySelector('[data-message-id="m2"]')
    const inserted = createMessageListItems([descriptor({ id: 'm3', role: 'user', sender: 'user', content: 'three', time: '10:02' })])[0]
    port.setItems([ITEMS[1], inserted, ITEMS[0]])
    expect([...result.container.querySelectorAll('[data-message-id]')].map(node => node.getAttribute('data-message-id'))).toEqual(['m2', 'm3', 'm1'])
    port.setItems([ITEMS[1]])
    expect(result.container.querySelector('[data-message-id="m2"]')).toBe(original)
    expect(result.container.querySelectorAll('[data-message-id]')).toHaveLength(1)
    expect(result.container.textContent).toBe('two')
  })

  it('用 Solid For 渲染全部 item，并通过 port 替换列表', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList
        initialItems={ITEMS}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))

    expect(result.container.querySelectorAll('[data-message-id]')).toHaveLength(2)
    expect(result.container.textContent).toContain('one')
    expect(result.container.textContent).toContain('two')

    port!.setItems([ITEMS[1]!])
    expect(result.container.querySelectorAll('[data-message-id]')).toHaveLength(1)
    expect(result.container.textContent).not.toContain('one')
  })

  it('反复用新对象替换同一消息列表时不累积 DOM 行', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList
        initialItems={ITEMS}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))

    for (let iteration = 0; iteration < 100; iteration += 1) {
      port!.setItems(createMessageListItems(ITEMS.map(item => ({
        ...item.descriptor,
        renderMessage: toRenderMessage({ ...item.descriptor.renderMessage.message }),
      }))))
    }

    const rows = result.container.querySelectorAll('[data-message-id]')
    expect(rows).toHaveLength(2)
    expect(result.container.querySelectorAll('[data-message-id="m1"]')).toHaveLength(1)
    expect(result.container.querySelectorAll('[data-message-id="m2"]')).toHaveLength(1)
  })

  it('同一 key 更新 descriptor 时保持行 DOM 身份并显示最新内容', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList
        initialItems={ITEMS}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))
    const row = result.container.querySelector('[data-message-id="m2"]')
    const updated = descriptor({
      ...ITEMS[1]!.descriptor.renderMessage.message,
      content: 'two updated incrementally',
    })

    port!.setItems(createMessageListItems([ITEMS[0]!.descriptor, updated]))

    expect(result.container.querySelector('[data-message-id="m2"]')).toBe(row)
    expect(row).toHaveTextContent('two updated incrementally')
  })

  // P57 S2-R3：引用相等喂入零成本通过——不调用行 update（descriptor getter 不再
  // 被读取）、不失效测量；引用变化的行照常更新。
  it('引用相等的 setItems 跳过行 update 与测量失效', async () => {
    let descriptorReads = 0
    const tracked: MessageListItem = {
      key: ITEMS[0]!.key,
      get descriptor() {
        descriptorReads += 1
        return ITEMS[0]!.descriptor
      },
    }
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList
        initialItems={[tracked, ITEMS[1]!]}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))
    const container = result.container.querySelector('[data-message-list="plain"]') as HTMLDivElement
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const baselineRevision = container.dataset.measurementRevision
    const baselineReads = descriptorReads

    // 全等引用喂入（上层 items memo per-key 复用后的形态）
    port!.setItems([tracked, ITEMS[1]!])
    await nextFrame()
    expect(container.dataset.measurementRevision).toBe(baselineRevision)
    expect(descriptorReads).toBe(baselineReads)

    // 引用变化喂入照常生效
    const updated = descriptor({ ...ITEMS[1]!.descriptor.renderMessage.message, content: 'changed' })
    port!.setItems([tracked, { key: updated.key, descriptor: updated }])
    await nextFrame()
    expect(container.dataset.measurementRevision).toBe(String(Number(baselineRevision) + 1))
    expect(result.container.querySelector('[data-message-id="m2"]')).toHaveTextContent('changed')
    // 未变化的 tracked 行不被牵连
    expect(descriptorReads).toBe(baselineReads)
  })

  it('scrollTo 只通过 messageId 定位内部行，不暴露 DOM', async () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const row = result.container.querySelector('[data-message-id="m2"]') as HTMLElement

    expect(await port!.scrollTo({ messageId: 'm2', align: 'center' })).toBe(true)
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(await port!.scrollTo({ messageId: 'missing', align: 'nearest' })).toBe(false)
  })

  it('scrollToBottom 使用内部 bottom anchor', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const bottom = result.container.querySelector('.plain-message-list__bottom') as HTMLElement

    port!.scrollToBottom('smooth')
    expect(bottom.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' })
  })

  it('读取 viewport state，返回可见首尾消息', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const container = result.container.querySelector('[data-message-list="plain"]') as HTMLDivElement
    const rows = [...result.container.querySelectorAll<HTMLElement>('[data-message-id]')]

    Object.defineProperties(container, {
      scrollTop: { value: 100, configurable: true },
      scrollHeight: { value: 500, configurable: true },
      clientHeight: { value: 200, configurable: true },
    })
    container.getBoundingClientRect = () => ({ top: 20, bottom: 220, left: 0, right: 100, width: 100, height: 200, x: 0, y: 20, toJSON() {} })
    rows[0]!.getBoundingClientRect = () => ({ top: 20, bottom: 100, left: 0, right: 100, width: 100, height: 80, x: 0, y: 20, toJSON() {} })
    rows[1]!.getBoundingClientRect = () => ({ top: 100, bottom: 230, left: 0, right: 100, width: 100, height: 130, x: 0, y: 100, toJSON() {} })

    expect(port!.getViewportState()).toMatchObject({
      distanceFromBottom: 200,
      atBottom: false,
      firstVisibleMessageId: 'm1',
      lastVisibleMessageId: 'm2',
    })
  })

  it('#212 S3b：冷开时按窗口渐进挂载（尾部优先），逐帧扩满', async () => {
    let port!: MessageListPort
    const result = render(() => (
      <PlainMessageList initialItems={[]} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const ids = () => [...result.container.querySelectorAll('[data-message-id]')]
      .map(node => node.getAttribute('data-message-id'))
    const hundred = createMessageListItems(Array.from({ length: 100 }, (_, index) => descriptor({
      id: `m${index}`, role: 'assistant', sender: 'agent', content: `row ${index}`, time: '10:00',
    })))

    port.setItems(hundred)
    // 首帧只挂窗口，且锚在**尾部**（用户先看到最新内容，历史从上方长出来）
    expect(ids()).toHaveLength(16)
    expect(ids()[0]).toBe('m84')
    expect(ids().at(-1)).toBe('m99')

    // 逐帧扩满
    await waitFor(() => expect(ids()).toHaveLength(100))
  })

  it('#212 S3b：增量增长不缩窗（小列表整挂）', () => {
    let port!: MessageListPort
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const ids = () => [...result.container.querySelectorAll('[data-message-id]')]
      .map(node => node.getAttribute('data-message-id'))
    const three = createMessageListItems([
      descriptor({ id: 'm3', role: 'user', sender: 'user', content: 'three', time: '10:02' }),
    ])
    port.setItems([...ITEMS, three[0]!])
    expect(ids()).toEqual(['m1', 'm2', 'm3'])
  })

  const rectOf = (top: number, bottom: number) => ({
    top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {},
  })

  /** 真实滚动容器：坐标基准必须是 scroller，不是列表容器（审核 M2）。 */
  function mountInScroller(props: { posture: 'follow' | 'pin' }) {
    const scroller = document.createElement('div')
    document.body.append(scroller)
    let scrollTop = 100
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop, set: (value: number) => { scrollTop = value }, configurable: true,
    })
    scroller.getBoundingClientRect = () => rectOf(0, 645)
    const result = render(() => (
      <PlainMessageList
        initialItems={ITEMS}
        scrollViewport={() => scroller}
        scrollPosture={() => props.posture}
        renderItem={item => item.key}
      />
    ), { container: scroller })
    // 列表容器**随内容一起平移**（生产的真实几何：它自己不滚动，上方内容长高会把它连同
    // 行一起推下去）。不模拟这一点，"用容器当基准"的错误实现会因为 jsdom 的零 rect
    // 退化成同样结果而蒙混过关——审核 M2 指出的正是旧用例把错误坐标系钉住了。
    let contentShift = 0
    const listContainer = scroller.querySelector<HTMLElement>('[data-message-list="plain"]')!
    listContainer.getBoundingClientRect = () => rectOf(contentShift, 645 + contentShift)
    return {
      scroller, result, readScrollTop: () => scrollTop,
      shiftContent: (value: number) => { contentShift = value },
    }
  }

  it('#212 S4：pin 姿态下上方行高度变化时补偿 scrollTop（自管锚点）', () => {
    const { scroller, readScrollTop, shiftContent } = mountInScroller({ posture: 'pin' })
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')]
    const observer = ResizeObserverMock.instances.at(-1)!
    // 文档空间 top = rect.top - 视口顶(0) + scrollTop(100)。row0 全在视口上方 ⇒ 不参与；
    // row1 从视口顶开始 ⇒ 它是锚。
    rows[0]!.getBoundingClientRect = () => rectOf(-180, -100)
    rows[1]!.getBoundingClientRect = () => rectOf(-100, 30)
    observer.emit()
    expect(readScrollTop()).toBe(100)

    // 上方行长高 50 ⇒ 行与容器一起下移 50（容器基准会抵掉这个位移，视口基准不会）⇒ 补偿 50
    shiftContent(50)
    rows[0]!.getBoundingClientRect = () => rectOf(-180, -50)
    rows[1]!.getBoundingClientRect = () => rectOf(-50, 80)
    observer.emit()
    expect(readScrollTop()).toBe(150)
  })

  it('#212 S4：follow 姿态不补偿（贴底跟随才是意图）', () => {
    const { scroller, readScrollTop } = mountInScroller({ posture: 'follow' })
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')]
    const observer = ResizeObserverMock.instances.at(-1)!
    rows[0]!.getBoundingClientRect = () => rectOf(-180, -100)
    rows[1]!.getBoundingClientRect = () => rectOf(-100, 30)
    observer.emit()
    rows[1]!.getBoundingClientRect = () => rectOf(-50, 80)
    observer.emit()
    expect(readScrollTop()).toBe(100)
  })

  it('#213：包装层 data-streaming 跟随权威活性（缺省仍回落 running）', async () => {
    const live = createMessageListItems([descriptor({ id: 'm9', role: 'assistant', sender: 'agent', content: '旧回合的残行', time: '10:00' })])
    // 投影语义仍是"未见终态"，但权威活性说"不在途"——包装层不得再播流式装饰。
    Object.assign(live[0]!.descriptor.renderMessage.message as object, { running: true })
    const first = render(() => (
      <PlainMessageList initialItems={live} onPortReady={() => {}} rowLive={() => false} renderItem={item => item.key} />
    ))
    await Promise.resolve()
    expect(first.container.querySelector('[data-streaming]')).toBeNull()

    // 缺省（不传 rowLive）回落 running ⇒ legacy 行为不变
    const second = render(() => (
      <PlainMessageList initialItems={live} onPortReady={() => {}} renderItem={item => item.key} />
    ))
    await Promise.resolve()
    expect(second.container.querySelector('[data-streaming="true"]')).not.toBeNull()
  })

  it('#212 S3b：换代中途挂起的扩窗不得按旧会话行数收敛', async () => {
    let port!: MessageListPort
    const result = render(() => (
      <PlainMessageList initialItems={[]} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const ids = () => result.container.querySelectorAll('[data-message-id]').length
    const mk = (count: number, prefix: string) => createMessageListItems(Array.from({ length: count }, (_, index) => descriptor({
      id: `${prefix}${index}`, role: 'assistant', sender: 'agent', content: `row ${index}`, time: '10:00',
    })))
    port.setItems(mk(100, 'a'))
    // 同一 tick 内换到更长的会话：挂起的扩窗必须改用新总长
    port.setItems(mk(300, 'b'))
    await waitFor(() => expect(ids()).toBe(300))
  })

  it('invalidation 与 ResizeObserver 更新 revision；destroy 幂等并清理 observer/DOM', () => {
    let port: MessageListPort | undefined
    const onContentResize = vi.fn()
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} onContentResize={onContentResize} renderItem={item => item.key} />
    ))
    const container = result.container.querySelector('[data-message-list="plain"]') as HTMLDivElement
    const observer = ResizeObserverMock.instances[0]!

    port!.invalidateMeasurements('theme-changed')
    expect(container.dataset.measurementRevision).toBe('1')
    expect(container.dataset.measurementReason).toBe('theme-changed')

    observer.emit()
    expect(container.dataset.measurementRevision).toBe('2')
    expect(container.dataset.measurementReason).toBe('container-resized')
    expect(observer.observe).toHaveBeenCalledTimes(3)
    expect(onContentResize).toHaveBeenCalledTimes(1)

    port!.destroy()
    port!.destroy()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(container.childElementCount).toBe(0)
  })
})
