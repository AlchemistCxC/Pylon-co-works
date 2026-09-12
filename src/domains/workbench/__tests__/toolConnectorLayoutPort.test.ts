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
  it('reads a shared anchor once per frame and completes all reads before writing', () => {
    const callbacks: (() => void)[] = []
    const port = createToolConnectorLayoutPort({ schedule(fn) { callbacks.push(fn); return fn }, cancel() {} })
    const order: string[] = []
    for (const [id, top] of [['a', 10], ['b', 40], ['c', 70]] as const) {
      port.registerTool(id, () => { order.push(`read-${id}`); return { head: rect(top, 0, 100, 20), indicator: rect(top, 8, 8, 8) } })
    }
    const layouts: unknown[] = []
    for (const [from, to] of [['a', 'b'], ['b', 'c']]) {
      port.registerConnector({ key: from, fromMessageId: from, toMessageId: to,
        measure() { order.push(`read-line-${from}`); return { parent: rect(0, 0, 300, 300), width: 2 } },
        apply(layout) { order.push(`write-${from}`); layouts.push(layout) },
      })
    }
    callbacks.shift()?.()
    expect(order.filter(item => item === 'read-b')).toHaveLength(1)
    expect(order.slice(-2)).toEqual(['write-a', 'write-b'])
    expect(layouts).toEqual([{ left: 11, top: 20, height: 30 }, { left: 11, top: 50, height: 30 }])
    order.length = 0
    port.invalidate('manual')
    callbacks.shift()?.()
    expect(order.filter(item => item.startsWith('write'))).toEqual([])
    expect(order.filter(item => item === 'read-b')).toHaveLength(1)
    port.destroy()
  })

  it('applies unchanged geometry to a replacement registration and ignores cleanup of its predecessor', () => {
    const callbacks: (() => void)[] = []
    const port = createToolConnectorLayoutPort({ schedule(fn) { callbacks.push(fn); return fn }, cancel() {} })
    const registration = { key: 'line', fromMessageId: 'a', toMessageId: 'b', measure: () => null }
    const oldApply = vi.fn(), newApply = vi.fn()
    const retire = port.registerConnector({ ...registration, apply: oldApply })
    callbacks.shift()?.()
    port.registerConnector({ ...registration, apply: newApply })
    callbacks.shift()?.()
    expect(newApply).toHaveBeenCalledOnce()
    retire()
    port.invalidate('manual')
    callbacks.shift()?.()
    expect(newApply).toHaveBeenCalledOnce()
    port.destroy()
  })

  it('does not apply the remaining batch after a connector destroys the port', () => {
    let frame!: () => void
    const port = createToolConnectorLayoutPort({ schedule(fn) { frame = fn; return fn }, cancel() {} })
    const after = vi.fn()
    port.registerConnector({ key: 'first', fromMessageId: 'a', toMessageId: 'b', measure: () => null, apply() { port.destroy() } })
    port.registerConnector({ key: 'next', fromMessageId: 'a', toMessageId: 'b', measure: () => null, apply: after })
    frame()
    expect(after.mock.calls).toEqual([[null]]) // destroy cleanup only
  })

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

  it('同一帧重复测量同一几何只写入一次，几何变化才追加写入', () => {
    const callbacks: (() => void)[] = []
    const scheduler: ToolConnectorScheduler = {
      schedule(callback) { callbacks.push(callback); return callback },
      cancel: vi.fn(),
    }
    const port = createToolConnectorLayoutPort(scheduler)
    const apply = vi.fn()
    let top = 10
    port.registerTool('from', () => ({ head: rect(top, 0, 100, 20), indicator: rect(top + 4, 8, 8, 8) }))
    port.registerTool('to', () => ({ head: rect(70, 0, 100, 20), indicator: rect(74, 8, 8, 8) }))
    port.registerConnector({ key: 'stable', fromMessageId: 'from', toMessageId: 'to', measure: () => ({ parent: rect(0, 0, 300, 300), width: 2 }), apply })
    callbacks.shift()?.()
    port.invalidate('manual')
    callbacks.shift()?.()
    expect(apply).toHaveBeenCalledTimes(1)
    top = 20
    port.invalidate('manual')
    callbacks.shift()?.()
    expect(apply).toHaveBeenCalledTimes(2)
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
