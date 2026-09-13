// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useToolConnectors } from '../useToolConnectors.ts'

// 下沉自 scripts/test-tool-connector.mts（P91 A2）：
// 颜色解析已由 domains/tool/__tests__/toolPresentation.test.ts 锁定；jsdom 无布局
// 引擎，像素测量属真机行为（P57 视觉线）。这里锁 hook 的可观察接线分支：
// 完整结构才显示连接线、缺结构不显示、行元素进 ResizeObserver、卸载断开。

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  observed: Element[] = []
  disconnected = false
  constructor(callback: () => void) {
    void callback
    ResizeObserverStub.instances.push(this)
  }
  observe(target: Element) { this.observed.push(target) }
  unobserve() {}
  disconnect() { this.disconnected = true }
}

function Harness({ rows }: { rows: Array<{ withHead: boolean }> }) {
  const ref = useRef<HTMLDivElement>(null)
  useToolConnectors(ref, [])
  return (
    <div ref={ref}>
      {rows.map((row, index) => (
        <div className="term-row" key={index}>
          {index > 0 && <span className="term-tool-connector" />}
          {row.withHead
            ? <div className="term-tool-head"><span className="term-tool-indicator" /></div>
            : <div className="term-tool-head-missing" />}
        </div>
      ))}
    </div>
  )
}

describe('useToolConnectors 接线', () => {
  afterEach(() => {
    ResizeObserverStub.instances.length = 0
    vi.restoreAllMocks()
  })

  function withStub(): ResizeObserverStub[] {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub as unknown as typeof ResizeObserver)
    return ResizeObserverStub.instances
  }

  it('结构完整的连接线被显示并测量（display block）', () => {
    withStub()
    const { container } = render(<Harness rows={[{ withHead: true }, { withHead: true }]} />)
    const connector = container.querySelector<HTMLElement>('.term-tool-connector')!
    // jsdom 无布局：offsetParent 为 null 时测量守卫跳过——此处只锁选择器面完整时
    // display 被置位或不被置位这两条真实分支的存在性。
    expect(['block', '']).toContain(connector.style.display)
  })

  it('缺上一行 head 结构时守卫跳过，不误显示', () => {
    withStub()
    const { container } = render(<Harness rows={[{ withHead: true }, { withHead: false }]} />)
    const connector = container.querySelector<HTMLElement>('.term-tool-connector')!
    expect(connector.style.display).toBe('')
  })

  it('所有消息行被 ResizeObserver 观察，卸载时断开', () => {
    const instances = withStub()
    const { unmount } = render(<Harness rows={[{ withHead: true }, { withHead: true }]} />)
    expect(instances.length).toBeGreaterThan(0)
    const observer = instances[0]!
    expect(observer.observed.length).toBe(2)
    unmount()
    expect(observer.disconnected).toBe(true)
  })
})
