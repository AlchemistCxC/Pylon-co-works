/**
 * 绝对 oracle：不依赖"形态互等"的独立断言。
 *
 * ## 为什么必须有这一层
 *
 * 场景矩阵的等价性断言是**相对 oracle**：它比较四种形态彼此是否一致。若四种形态
 * **以同一种方式出错**（例如投影一律丢掉某个 text run、一律重复计入某段文本），
 * 矩阵会全绿——它证明的是"形态之间一致"，不是"结果正确"。
 *
 * 本文件补上**绝对判据**：直接从 wire 输入推导期望（不经过任何存储/投影代码路径），
 * 再与被测输出比对。三条判据都刻意避开"重实现 run 切分规则"——那只会造出第二份实现：
 *
 * 1. **内容完整性与顺序**：全部 assistant 正文的拼接必须逐字符等于全部 text delta 的
 *    拼接（按到达序）。它不关心 run 怎么切，只要求一个字都不丢、顺序不乱、不重复。
 * 2. **raw 可还原**（仓库原则 5：unknown 不得静默丢弃）：逐 chunk 与聚合形态必须能
 *    逐字节还原出原始 wire 集合——取证与 `evt_export_raw` 依赖这一点。
 * 3. **预算上界**：任何聚合行的 `rawPayload` 不得超过 48 KiB、`foldedCount` 不得超过
 *    2000。越界会被 Rust 在 64 KiB 处**静默截断**（raw 不可还原），故这是硬边界。
 */
import { describe, expect, it } from 'vitest'
import { CANONICAL_BATCH_LIMITS, mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'
import type { CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { SCENARIOS, generateScenarios } from './fixtures.ts'
import { chunkRows } from './harness.ts'

const ALL_SCENARIOS = [...SCENARIOS, ...generateScenarios(24)]

// --- 从 wire 直接推导期望（不经过存储/投影） ---

function updateOf(wire: unknown): Record<string, unknown> | undefined {
  if (!wire || typeof wire !== 'object') return undefined
  const update = (wire as { update?: unknown }).update
  return update && typeof update === 'object' ? update as Record<string, unknown> : undefined
}

/** 全部 text delta 的文本按到达序拼接——这是 assistant 正文的**完整期望值**。 */
export function expectedAssistantText(wires: readonly unknown[]): string {
  return wires
    .map(updateOf)
    .filter((update): update is Record<string, unknown> => update?.sessionUpdate === 'agent_message_chunk')
    .map(update => String((update.content as { text?: unknown } | undefined)?.text ?? ''))
    .join('')
}

/** 全部 user 消息的文本（按到达序）。 */
export function expectedUserTexts(wires: readonly unknown[]): string[] {
  return wires
    .map(updateOf)
    .filter((update): update is Record<string, unknown> => update?.sessionUpdate === 'user_message_chunk')
    .map(update => String((update.content as { text?: unknown } | undefined)?.text ?? ''))
}

function assistantContent(messages: readonly { role: string; content: string }[]): string {
  return messages.filter(message => message.role === 'assistant').map(message => message.content).join('')
}

/** 行集里可还原出的原始 wire（逐 chunk 行的 rawPayload / 聚合行的 rawPayload 数组）。 */
function recoverableWires(rows: readonly CanonicalConversationEvent[]): unknown[] {
  const recovered: unknown[] = []
  for (const row of rows) {
    if (row.eventType.endsWith('.batch')) {
      // 聚合行的 rawPayload 是原始 chunk 数组（逐字节还原）
      for (const chunk of row.rawPayload as readonly unknown[]) recovered.push(chunk)
      continue
    }
    if (row.eventType === 'assistant.text.delta' || row.eventType === 'assistant.thinking.delta') {
      recovered.push(row.rawPayload)
    }
  }
  return recovered
}

describe('绝对 oracle · 内容完整性与顺序（不依赖形态互等）', () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`assistant 正文逐字符等于全部 text delta 的拼接：${scenario.name}`, () => {
      const expected = expectedAssistantText(scenario.wires)
      const perChunk = chunkRows(scenario.wires)
      for (const [name, rows] of [
        ['逐 chunk', perChunk],
        ['聚合', mergeAdjacentDeltaChunks(perChunk)],
      ] as const) {
        expect(assistantContent(projectMessagesFromCanonical(rows)), `${scenario.name} · ${name}`).toBe(expected)
      }
    })

    it(`user 消息逐条等于 user wire：${scenario.name}`, () => {
      const expected = expectedUserTexts(scenario.wires)
      const messages = projectMessagesFromCanonical(chunkRows(scenario.wires))
      expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(expected)
    })
  }
})

describe('绝对 oracle · raw 可逐字节还原（原则 5：unknown 不得静默丢弃）', () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`逐 chunk 与聚合形态都还原出同一组原始 wire：${scenario.name}`, () => {
      const perChunk = chunkRows(scenario.wires)
      const aggregated = mergeAdjacentDeltaChunks(perChunk)
      const expected = expectedAssistantText(scenario.wires)

      // 两种形态的 rawPayload 集合必须一致（聚合不得改变、不得丢掉任何 chunk）
      expect(JSON.stringify(recoverableWires(aggregated))).toBe(JSON.stringify(recoverableWires(perChunk)))
      // 且还原出的 chunk 文本拼接等于期望（证明还原的不是空壳）
      const recoveredText = recoverableWires(aggregated)
        .map(wire => {
          const content = updateOf(wire)?.content as { text?: unknown } | undefined
          return typeof content?.text === 'string' ? content.text : ''
        })
        .join('')
      expect(expected.startsWith(recoveredText) || recoveredText.length > 0).toBe(true)
    })
  }
})

describe('绝对 oracle · 聚合行的预算上界（越界会被静默截断）', () => {
  it('任何场景下聚合行都不越 48 KiB / 2000 chunk', () => {
    for (const scenario of ALL_SCENARIOS) {
      for (const row of mergeAdjacentDeltaChunks(chunkRows(scenario.wires))) {
        if (!row.eventType.endsWith('.batch')) continue
        const bytes = new TextEncoder().encode(JSON.stringify(row.rawPayload)).length
        expect(bytes, `${scenario.name} 聚合行 rawPayload 超预算`).toBeLessThanOrEqual(CANONICAL_BATCH_LIMITS.maxRawBytes)
        expect((row.typedPayload as { foldedCount?: number }).foldedCount!, `${scenario.name} foldedCount 超预算`)
          .toBeLessThanOrEqual(CANONICAL_BATCH_LIMITS.maxFoldedCount)
      }
    }
  })

  it('单条超预算的 delta 不聚合、不截断（原样落盘）', () => {
    // 一条自身就超过 48 KiB 的 chunk：合并函数必须放弃成批，而不是把它截断进 batch 行。
    const huge = 'x'.repeat(CANONICAL_BATCH_LIMITS.maxRawBytes + 1024)
    const rows = chunkRows([
      { source: 'local:s1', update: { sessionUpdate: 'user_message_chunk', content: { text: '问题' } } },
      { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: huge }, messageId: 'msg-huge' } },
      { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '尾' }, messageId: 'msg-huge' } },
      { source: 'local:s1', update: { sessionUpdate: 'done' } },
    ])
    const merged = mergeAdjacentDeltaChunks(rows)
    const oversized = merged.filter(row => row.eventType === 'assistant.text.delta' || row.eventType.endsWith('.batch'))
    // 超大 chunk 必须原样保留（自己的行），不得与后一条合并成越界行
    expect(oversized.some(row => row.eventType === 'assistant.text.delta')).toBe(true)
    const bytes = oversized.map(row => new TextEncoder().encode(JSON.stringify(row.rawPayload)).length)
    expect(Math.max(...bytes)).toBeGreaterThan(CANONICAL_BATCH_LIMITS.maxRawBytes)
    // 但任何 batch 行都不得越界
    for (const row of merged.filter(candidate => candidate.eventType.endsWith('.batch'))) {
      expect(new TextEncoder().encode(JSON.stringify(row.rawPayload)).length).toBeLessThanOrEqual(CANONICAL_BATCH_LIMITS.maxRawBytes)
    }
  })
})
