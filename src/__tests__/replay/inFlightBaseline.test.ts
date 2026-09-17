/**
 * ③ 在途重放基线：无终态行的回合必须可完整重放。
 *
 * 这是「流式输出中切换页面」这条要求的数据面底线。
 *
 * 今天的机制：`turn.unit` 只在终态构建（`turn_rollup.rs`：未终结 turn 不折叠），所以
 * 在途内容由逐 chunk 行承载，冷重放自然完整。
 *
 * 这条基线的价值在于它是**「消息边界才落盘」会打破、而「两级存储（历史 + draft 尾巴）」
 * 必须靠 draft tail 才能保住**的那一条。动手改存储之前先钉住它：将来任何改动只要让它
 * 变红，就是打破了在途重放——而不是"偶发"。
 */
import { describe, expect, it } from 'vitest'
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'
import { IN_FLIGHT_WIRES, assistantRuns, chunkRows, rawThinking, rawText, rawUser } from './harness.ts'

describe('③ 在途重放基线（无终态行）', () => {
  it('在途正文被完整重放：内容不丢、顺序不乱，且投影形状被钉住', () => {
    const messages = projectMessagesFromCanonical(chunkRows(IN_FLIGHT_WIRES))

    // 投影形状事实：夹入 thinking 会把文本 run 切成两条助手消息。故断言落在
    // "每个 run 内部连续"，而不是全局拼接。
    expect(assistantRuns(messages)).toEqual(['甲', '乙丙'])
    expect(messages.some(message => message.role === 'user' && message.content === '问题')).toBe(true)
  })

  it('在途行集聚合后重放等价：聚合不得改变在途正文', () => {
    const perChunk = chunkRows(IN_FLIGHT_WIRES)
    const merged = mergeAdjacentDeltaChunks(perChunk)

    expect(merged.some(row => row.eventType.endsWith('.batch'))).toBe(true)
    expect(JSON.stringify(projectMessagesFromCanonical(merged)))
      .toBe(JSON.stringify(projectMessagesFromCanonical(perChunk)))
  })

  it('思考回合（仅 thinking、无 text）在途时投影非空', () => {
    const messages = projectMessagesFromCanonical(chunkRows([
      rawUser('问题'),
      rawThinking('思一'),
      rawThinking('思二'),
    ]))
    // 仅思考的回合不得投影为空，否则在途切页会看到"什么都没有"
    expect(JSON.stringify(messages).length).toBeGreaterThan(2)
  })

  it('首条 delta 单独到达（聚合不成立的最小形态）也可重放且不产生聚合行', () => {
    const merged = mergeAdjacentDeltaChunks(chunkRows([rawUser('问题'), rawText('仅此一段')]))
    // 单条 run 不合并（保持逐字节一致）
    expect(merged.some(row => row.eventType.endsWith('.batch'))).toBe(false)
    expect(assistantRuns(projectMessagesFromCanonical(merged))).toEqual(['仅此一段'])
  })
})
