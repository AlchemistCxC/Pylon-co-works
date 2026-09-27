// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { WorkbenchDocument } from '../../../domains/workbench/workbenchProjector.ts'
import { selectActivityTimelinePlacement } from '../solidWorkbenchProjectionSupport.ts'

/**
 * #409：placement 二分化的等价性差分测试。
 *
 * oracle 是改造前的线性扫描算法（逐活动扫全部消息，严格 `>` 保留数组序第一条），
 * 与新实现（收集序列 + 两次二分）在固定边界用例与随机用例上逐项对拍：
 * 领头段、锚 id、段内顺序必须完全一致。
 */

interface MinimalMessage { id: string; sequence: number }

/** 改造前的线性 oracle（语义基准，见 issue #409 A 项）。 */
function linearOracle(messages: readonly MinimalMessage[], activities: readonly { id: string; sequence: number }[]) {
  const leading: string[] = []
  const afterMessage = new Map<string, string[]>()
  for (const activity of activities) {
    let anchor: MinimalMessage | undefined
    for (const message of messages) {
      if (message.sequence >= activity.sequence) continue
      if (!anchor || message.sequence > anchor.sequence) anchor = message
    }
    if (!anchor) {
      leading.push(activity.id)
      continue
    }
    const anchored = afterMessage.get(anchor.id) ?? []
    anchored.push(activity.id)
    afterMessage.set(anchor.id, anchored)
  }
  return { leading, afterMessage }
}

function asDocument(messages: readonly MinimalMessage[], activities: readonly { id: string; sequence: number }[]): WorkbenchDocument {
  return {
    messages,
    activities: activities.map(activity => ({ id: activity.id, sequence: activity.sequence })),
  } as unknown as WorkbenchDocument
}

function runBoth(messages: readonly MinimalMessage[], activities: readonly { id: string; sequence: number }[]) {
  const placement = selectActivityTimelinePlacement(asDocument(messages, activities))
  const oracle = linearOracle(messages, activities)
  const actual = {
    leading: placement.leading.map(node => node.id),
    afterMessage: new Map([...placement.afterMessage.entries()].map(([id, nodes]) => [id, nodes.map(node => node.id)])),
  }
  return { actual, oracle }
}

function expectEquivalent(messages: readonly MinimalMessage[], activities: readonly { id: string; sequence: number }[]) {
  const { actual, oracle } = runBoth(messages, activities)
  expect(actual.leading).toEqual(oracle.leading)
  expect([...actual.afterMessage.entries()]).toEqual([...oracle.afterMessage.entries()])
}

describe('#409 selectActivityTimelinePlacement 二分化与线性 oracle 等价', () => {
  it('升序消息：活动锚在最近的前序消息', () => {
    expectEquivalent(
      [ { id: 'm1', sequence: 1 }, { id: 'm2', sequence: 5 }, { id: 'm3', sequence: 9 } ],
      [ { id: 'a1', sequence: 3 }, { id: 'a2', sequence: 6 }, { id: 'a3', sequence: 10 } ],
    )
  })

  it('空消息：全部活动落领头段', () => {
    expectEquivalent([], [ { id: 'a1', sequence: 1 } ])
  })

  it('活动 sequence 早于全部消息：落领头段', () => {
    expectEquivalent(
      [ { id: 'm1', sequence: 10 } ],
      [ { id: 'a1', sequence: 2 } ],
    )
  })

  it('平 sequence 的消息：锚取数组序第一条（严格 > 不替换）', () => {
    expectEquivalent(
      [ { id: 'first', sequence: 4 }, { id: 'second', sequence: 4 }, { id: 'third', sequence: 4 } ],
      [ { id: 'a1', sequence: 5 } ],
    )
  })

  it('乱序消息：与 oracle（数组序线性扫描）一致', () => {
    expectEquivalent(
      [ { id: 'm9', sequence: 9 }, { id: 'm2', sequence: 2 }, { id: 'm7', sequence: 7 }, { id: 'm4', sequence: 4 } ],
      [ { id: 'a1', sequence: 3 }, { id: 'a2', sequence: 8 }, { id: 'a3', sequence: 12 } ],
    )
  })

  it('乱序 + 平 sequence 组合：与 oracle 一致', () => {
    expectEquivalent(
      [ { id: 'mA', sequence: 6 }, { id: 'mB', sequence: 2 }, { id: 'mC', sequence: 6 }, { id: 'mD', sequence: 1 } ],
      [ { id: 'a1', sequence: 6 }, { id: 'a2', sequence: 7 }, { id: 'a3', sequence: 9 } ],
    )
  })

  it('随机化对拍（有序与乱序输入各 200 轮）', () => {
    let seed = 0x409
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let round = 0; round < 200; round += 1) {
      const messageCount = 1 + Math.floor(random() * 12)
      const messages: MinimalMessage[] = []
      let sequence = 0
      for (let index = 0; index < messageCount; index += 1) {
        sequence += Math.floor(random() * 3)
        messages.push({ id: `m${index}`, sequence })
      }
      const shuffled = [...messages]
      if (round % 2 === 1) shuffled.sort(() => random() - 0.5)
      const activities = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, index) => ({
        id: `a${index}`,
        sequence: Math.floor(random() * (sequence + 3)),
      }))
      expectEquivalent(shuffled, activities)
    }
  })
})
