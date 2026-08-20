import { describe, expect, it, vi } from 'vitest'
import {
  calculateToolConnectorLayout,
  createToolConnectorLayoutPort,
  type ToolConnectorScheduler,
} from '../toolConnectorLayoutPort.ts'

function rect(top: number, left: number, width: number, height: number) {
  return { top, left, width, height }
}

describe('ToolConnectorLayoutPort', () => {
  it('从两个 Tool head 中心和起点 indicator 中心计算连接线几何', () => {
    expect(calculateToolConnectorLayout(
      { head: rect(120, 20, 200, 20), indicator: rect(124, 30, 10, 10) },
      { head: rect(220, 20, 200, 40), indicator: rect(226, 30, 10, 10) },
      { parent: rect(100, 10, 500, 500), width: 2 },
    )).toEqual({ left: 24, top: 30, height: 110 })
  })

  it('批量 invalidation 只调度一次，并向 connector apply 计算结果', () => {
    const callbacks: (() => void)[] = []
    const scheduler: ToolConnectorScheduler = {
      schedule(callback) { callbacks.push(callback); return callback },
      cancel: vi.fn(),
    }
    const port = createToolConnectorLayoutPort(scheduler)
    const apply = vi.fn()
    port.registerTool('from', () => ({ head: rect(10, 0, 100, 20), indicator: rect(14, 8, 8, 8) }))
    port.registerTool('to', () => ({ head: rect(70, 0, 100, 20), indicator: rect(74, 8, 8, 8) }))
    port.registerConnector({
      key: 'from-to', fromMessageId: 'from', toMessageId: 'to',
      measure: () => ({ parent: rect(0, 0, 300, 300), width: 2 }),
      apply,
    })
    port.invalidate('theme-changed')
    port.invalidate('font-changed')

    expect(callbacks).toHaveLength(1)
    callbacks[0]!()
    expect(apply).toHaveBeenLastCalledWith({ left: 11, top: 20, height: 60 })
  })

  it('缺失任一 anchor 时隐藏 connector；注销和 destroy 幂等清理', () => {
    let callback: (() => void) | undefined
    const cancel = vi.fn()
    const port = createToolConnectorLayoutPort({
      schedule(next) { callback = next; return 1 },
      cancel,
    })
    const apply = vi.fn()
    const unregisterConnector = port.registerConnector({
      key: 'missing', fromMessageId: 'from', toMessageId: 'to',
      measure: () => ({ parent: rect(0, 0, 1, 1), width: 2 }), apply,
    })
    callback?.()
    expect(apply).toHaveBeenLastCalledWith(null)

    unregisterConnector()
    unregisterConnector()
    port.invalidate('manual')
    port.destroy()
    port.destroy()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
