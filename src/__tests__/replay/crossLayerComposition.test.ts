/**
 * ④ 跨层组合：同一输入在多种存储形态下，三层观测量必须彼此一致。
 *
 * 这是本目录的核心。各层都有单测，但此前**没有任何测试断言整条管线彼此一致**——
 * 于是"改动会打破哪一层"只能靠猜。组合测试把这件事变成一个可定位的红点。
 *
 * 三层观测量：
 * - 投影层：`Message[]`（逐字节）
 * - 边界层：`deriveCanonicalTurnDuration` / `hasCanonicalTurnTerminal`
 * - 游标层：消费完整行集后的 cursor 位置
 *
 * 已知的分歧只有一个，且是显式的：**游标层无法接受聚合形态**（聚合行的占用跨度让它
 * 判 gap）。它被写成 todo，而不是被藏起来——那就是修复的靶子。
 */
import { describe, expect, it, vi } from 'vitest'
import { CanonicalEventCursor } from '../../infrastructure/events/canonicalEventCursor.ts'
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch.ts'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal } from '../../domains/events/canonicalTurnDuration.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'
import { COMPOSED_WIRES, OWNER_KEY, assistantRuns, boundaryOf, chunkRows } from './harness.ts'

describe('④ 跨层组合 · 同一回合的多形态三层一致', () => {
  it('投影层：逐 chunk 与聚合形态的 Message[] 逐字节相等', () => {
    const perChunk = chunkRows(COMPOSED_WIRES)
    const merged = mergeAdjacentDeltaChunks(perChunk)

    // 聚合必须真的发生，否则等价断言是空转
    expect(merged.some(row => row.eventType.endsWith('.batch'))).toBe(true)
    expect(JSON.stringify(projectMessagesFromCanonical(merged)))
      .toBe(JSON.stringify(projectMessagesFromCanonical(perChunk)))
  })

  it('组合：投影层与边界层在同一份行集上同时成立（聚合形态）', () => {
    const merged = mergeAdjacentDeltaChunks(chunkRows(COMPOSED_WIRES))

    // 投影层：正文完整且顺序落定
    expect(assistantRuns(projectMessagesFromCanonical(merged)).join('')).toContain('甲乙丙')
    // 边界层：终态存在，且能从行自身的时间戳推出时长
    expect(hasCanonicalTurnTerminal(merged)).toBe(true)
    expect(deriveCanonicalTurnDuration(merged.map(boundaryOf))).toBeDefined()
  })

  it('游标层：逐 chunk 形态可推进到最后一条 sequence', async () => {
    const rows = chunkRows(COMPOSED_WIRES)
    const cursor = new CanonicalEventCursor({ list: vi.fn() })
    const applied: number[] = []

    for (const row of rows) await cursor.accept(row, consumed => { applied.push(consumed.sequence) })

    expect(applied).toEqual(rows.map(row => row.sequence))
    expect(cursor.cursor(OWNER_KEY)).toBe(rows.length)
  })

  it.todo('游标层：聚合形态应与逐 chunk 形态推进到同一位置（现状抛 gap；这是修复的靶子）')
})
