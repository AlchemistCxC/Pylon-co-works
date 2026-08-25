// @vitest-environment jsdom
import { render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRowDescriptor } from '../../../../components/chat/chatRowPipeline.ts'
import { toRenderMessage, type Message } from '../../../../components/chat/messageTypes.ts'
import { createMessageListItems, type MessageListPort } from '../../../../domains/workbench/messageListPort.ts'
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
