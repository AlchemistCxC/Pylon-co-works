/**
 * 增量读与顺序无关性：对应"流式输出中切页 / 分页补读"的数据面性质。
 *
 * 纯投影是函数，所以"分页后拼接"本身必然一致；真正需要钉的是下面三条——它们各自
 * 对应一种真实的读取形态，且都**不是**自明的：
 *
 * 1. **正文单调增长**：按前缀读时，assistant 正文只能是最终正文的**前缀**，不得出现
 *    "先给了再改"（改写会让在途切页看到文本跳动）。这条只对 assistant 正文成立——
 *    user 消息会因 optimistic reconciliation 被替换/去重，不能要求单调。
 * 2. **顺序无关**：行集乱序喂入必须得到同一投影（读路径可能按页/按 owner 拼接，
 *    顺序不由投影保证）。
 * 3. **越界的行不得污染正常行**：单条畸形/越界行不能让整份会话投影塌掉或丢内容
 *    （与 unit 的段级隔离同精神，但这里是行级）。
 */
import { describe, expect, it } from 'vitest'
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'
import type { CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { SCENARIOS, generateScenarios } from './fixtures.ts'
import { REAL_FIXTURE_SCENARIOS } from './realFixtures.ts'
import { chunkRows } from './harness.ts'
import { assistantContent, isSubsequence } from './oracles.ts'

const ALL_SCENARIOS = [...SCENARIOS, ...REAL_FIXTURE_SCENARIOS, ...generateScenarios(16)]

function assistantContentOf(rows: readonly CanonicalConversationEvent[]): string {
  return assistantContent(projectMessagesFromCanonical(rows))
}

/** 确定性洗牌（不用随机，避免 flaky）。 */
function rotate<T>(items: readonly T[], by: number): T[] {
  const offset = ((by % items.length) + items.length) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

describe('增量读 · assistant 正文单调增长（前缀性）', () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`每个读取前缀都是最终正文的前缀：${scenario.name}`, () => {
      const rows = chunkRows(scenario.wires)
      const full = assistantContentOf(rows)
      for (let length = 0; length <= rows.length; length += 1) {
        const prefix = assistantContentOf(rows.slice(0, length))
        expect(full.startsWith(prefix), `${scenario.name} 前缀 ${length} 不是最终正文的前缀`).toBe(true)
      }
    })

    it(`聚合形态同样满足前缀性：${scenario.name}`, () => {
      const rows = mergeAdjacentDeltaChunks(chunkRows(scenario.wires))
      const full = assistantContentOf(rows)
      for (let length = 0; length <= rows.length; length += 1) {
        expect(full.startsWith(assistantContentOf(rows.slice(0, length))), `${scenario.name} 聚合前缀 ${length}`).toBe(true)
      }
    })
  }
})

describe('增量读 · 顺序无关', () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`按序与轮转喂入得到同一投影：${scenario.name}`, () => {
      const rows = chunkRows(scenario.wires)
      const expected = JSON.stringify(projectMessagesFromCanonical(rows))
      for (const by of [1, 2, Math.max(1, rows.length - 1)]) {
        expect(JSON.stringify(projectMessagesFromCanonical(rotate(rows, by))), `${scenario.name} 轮转 ${by}`).toBe(expected)
      }
    })

    it(`完全逆序喂入同样是同一投影：${scenario.name}`, () => {
      const rows = chunkRows(scenario.wires)
      const expected = JSON.stringify(projectMessagesFromCanonical(rows))
      expect(JSON.stringify(projectMessagesFromCanonical([...rows].reverse())), `${scenario.name} 逆序`).toBe(expected)
    })
  }
})

describe('增量读 · 越界/畸形行不得污染正常行（行级隔离）', () => {
  const rows = chunkRows(SCENARIOS[6]!.wires)
  const expected = assistantContentOf(rows)

  /**
   * 毒行**追加**而非替换既存行，且断言用**子序列**而非"包含子串"：
   *
   * - 追加而非替换：契约是"坏行可以引入它自己的垃圾，但不得破坏或吞掉既有内容"。
   *   若替换掉一条真正文行，断言就变成"毒行的文本不该出现"——那不是契约而是对降级
   *   路径的臆测（首版正是这么写错的：聚合行正文取自 `typedPayload.text`，其 'x' 会
   *   照常投影出来）。
   * - 子序列而非子串：毒行继承了既存行的 sequence，会按 sequence 排进正文中间，于是
   *   既有正文不再是连续子串。而"字符按原序一个不少"才是真正要守的性质（不丢弃、
   *   不乱序），插入的垃圾不违反它。
   */
  const poisons: ReadonlyArray<readonly [string, CanonicalConversationEvent]> = [
    ['跨度越出 revision 的聚合行', { ...rows[1]!, eventType: 'assistant.text.delta.batch', typedPayload: { text: 'x', foldedCount: 2, seqSpan: [900, 901] }, rawPayload: [rows[1]!.rawPayload] }],
    ['foldedCount 与跨度不一致', { ...rows[1]!, eventType: 'assistant.text.delta.batch', typedPayload: { text: 'x', foldedCount: 99, seqSpan: [1, 2] }, rawPayload: [rows[1]!.rawPayload] }],
    ['rawPayload 非数组的聚合行', { ...rows[1]!, eventType: 'assistant.text.delta.batch', typedPayload: { text: 'x', foldedCount: 1, seqSpan: [1, 1] }, rawPayload: { not: 'an array' } }],
    ['sequence 为 0 的行（排序会插到最前）', { ...rows[1]!, sequence: 0 }],
    ['未知事件类型', { ...rows[1]!, eventType: 'future.unknown.event' as never }],
  ]

  for (const [name, poison] of poisons) {
    it(`${name}：不得抛错，既有正文按原序一个不少`, () => {
      const spliced = [...rows, poison]
      expect(() => projectMessagesFromCanonical(spliced)).not.toThrow()
      expect(isSubsequence(expected, assistantContentOf(spliced)), `${name}：既有正文被丢弃或乱序`).toBe(true)
    })
  }

  it('一次塞入全部毒行仍不抛错，且既有正文按原序不缺', () => {
    const spliced = [...rows, ...poisons.map(([, poison]) => poison)]
    expect(() => projectMessagesFromCanonical(spliced)).not.toThrow()
    expect(isSubsequence(expected, assistantContentOf(spliced))).toBe(true)
  })
})
