// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeToolConnectorLayoutPort } from '../../../../domains/workbench/fakeToolConnectorLayoutPort.ts'
import { createToolConnectorLayoutPort } from '../../../../domains/workbench/toolConnectorLayoutPort.ts'
import { SolidToolConnector } from '../ToolConnector.solid.tsx'
import { SolidToolCard } from '../ToolCard.solid.tsx'

const APPEARANCE = {
  toolConnectorMode: 'follow',
  toolConnectorColor: '#111111',
  toolConnectorStyle: 'dotted',
  toolConnectorWidth: 9,
  toolConnectorOpacity: 0,
}

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }
  emit() { this.callback([], this as unknown as ResizeObserver) }
  unobserve() {}
}

beforeEach(() => {
  ResizeObserverMock.instances = []
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SolidToolConnector', () => {
  it('保留 mode/style/motion/data contract，并 clamp width/opacity', () => {
    const port = createFakeToolConnectorLayoutPort()
    const result = render(() => <SolidToolConnector
      connectorKey="a-b"
      fromMessageId="a"
      toMessageId="b"
      status="ok"
      visualState="completed"
      appearance={APPEARANCE}
      colors={{ toolOk: '#22aa44' }}
      layoutPort={port}
    />)
    const connector = result.container.querySelector('.term-tool-connector') as HTMLElement

    expect(connector.classList.contains('term-tool-connector-style--dotted')).toBe(true)
    expect(connector.classList.contains('term-tool-connector--settle')).toBe(true)
    expect(connector.dataset.toolState).toBe('completed')
    expect(connector.dataset.connectorMode).toBe('follow')
    expect(connector.style.background).toBe('rgb(34, 170, 68)')
    expect(connector.style.getPropertyValue('--tool-connector-width')).toBe('6px')
    expect(connector.style.getPropertyValue('--tool-connector-opacity')).toBe('0.1')
    expect(port.connectorKeys).toEqual(['a-b'])
  })

  it('通过 layout port 应用 DOM 几何，不从业务层 querySelector 行', () => {
    let scheduled: (() => void) | undefined
    const port = createToolConnectorLayoutPort({
      schedule(callback) { scheduled = callback; return callback },
      cancel() {},
    })
    const result = render(() => (
      <div class="term">
        <SolidToolCard
          messageId="a"
          layoutPort={port}
          message={{ id: 'a', role: 'tool', sender: 'tool:Read', content: '', time: 't', toolName: 'Read', toolStatus: 'completed', toolOutput: 'a' }}
          appearance={{ toolIndicator: 'circle', toolIndicatorGlow: 0, toolIndicatorGlowColor: '' }}
        />
        <SolidToolConnector
          connectorKey="a-b" fromMessageId="a" toMessageId="b" status="ok" visualState="completed"
          appearance={{ ...APPEARANCE, toolConnectorStyle: 'solid' }} layoutPort={port}
        />
        <SolidToolCard
          messageId="b"
          layoutPort={port}
          message={{ id: 'b', role: 'tool', sender: 'tool:Write', content: '', time: 't', toolName: 'Write', toolStatus: 'completed', toolOutput: 'b' }}
          appearance={{ toolIndicator: 'circle', toolIndicatorGlow: 0, toolIndicatorGlowColor: '' }}
        />
      </div>
    ))
    const term = result.container.querySelector('.term') as HTMLElement
    const heads = [...result.container.querySelectorAll<HTMLElement>('.term-tool-head')]
    const indicators = [...result.container.querySelectorAll<HTMLElement>('.term-tool-indicator')]
    const connector = result.container.querySelector('.term-tool-connector') as HTMLElement

    term.getBoundingClientRect = () => domRect(0, 0, 500, 500)
    Object.defineProperty(connector, 'offsetParent', { value: term, configurable: true })
    Object.defineProperty(connector, 'offsetWidth', { value: 2, configurable: true })
    heads[0]!.getBoundingClientRect = () => domRect(20, 10, 200, 20)
    heads[1]!.getBoundingClientRect = () => domRect(100, 10, 200, 20)
    indicators[0]!.getBoundingClientRect = () => domRect(24, 30, 10, 10)
    indicators[1]!.getBoundingClientRect = () => domRect(104, 30, 10, 10)

    port.invalidate('manual')
    scheduled?.()
    expect(connector.style.display).toBe('block')
    expect(connector.style.left).toBe('34px')
    expect(connector.style.top).toBe('30px')
    expect(connector.style.height).toBe('80px')
  })

  it('ResizeObserver invalidation、unmount 与 destroy 清理注册', () => {
    const port = createFakeToolConnectorLayoutPort()
    const result = render(() => <SolidToolConnector
      connectorKey="a-b" fromMessageId="a" toMessageId="b" status="run"
      appearance={APPEARANCE} layoutPort={port}
    />)
    ResizeObserverMock.instances[0]!.emit()
    expect(port.invalidations).toContain('row-resized')

    result.unmount()
    expect(port.connectorKeys).toEqual([])
    expect(ResizeObserverMock.instances[0]!.disconnect).toHaveBeenCalledTimes(1)
    port.destroy()
    expect(port.destroyed).toBe(true)
  })
})

function domRect(top: number, left: number, width: number, height: number): DOMRect {
  return { top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON() {} }
}
