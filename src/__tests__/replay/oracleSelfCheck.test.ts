/**
 * oracle 自检：验证"度量尺本身"是准的。
 *
 * ## 为什么这一步比再多写几条断言更重要
 *
 * 一套测试的可信度上限由**oracle 的正确性**决定：如果期望值算错（例如只认驼峰键名、
 * 少算一段文本、把子序列判成子串），那么断言会**静默通过**——绿灯不代表正确，只代表
 * "被测对象与错误的期望一致"。这类失败比缺测试更危险，因为它伪装成覆盖。
 *
 * 所以每条判据都要能回答："它真的会红吗？" 本文件对每个 oracle 做两件事：
 * 1. **正例**：对已知输入给出已知输出（证明它会算）；
 * 2. **反例**：对故意做错的输入必须变红（证明它会叫）。
 *
 * 反例是这里的关键——只测正例的 oracle 无法区分"判据成立"与"判据从不触发"。
 */
import { describe, expect, it } from 'vitest'
import { inspectSequenceSpace } from './invariants.ts'
import { expectReplayInvariants } from './invariants.ts'
import { SCENARIOS } from './fixtures.ts'
import { chunkRows, rawText, rawUser } from './harness.ts'
import { expectedAssistantText, expectedUserTexts } from './oracles.ts'

// --- oracle 1：正文期望值（含键名约定） ---

describe('oracle 自检 · expectedAssistantText', () => {
  it('正例：按到达序拼接全部 text delta', () => {
    const wires = [rawUser('问'), rawText('甲'), rawText('乙')]
    expect(expectedAssistantText(wires)).toBe('甲乙')
  })

  it('正例：同时识别驼峰与蛇形两种键名（真实样本两者都存在）', () => {
    const camel = rawText('驼')
    const snake = { source: 'local:s1', update: { session_update: 'agent_message_chunk', content: { type: 'text', text: '蛇' } } }
    expect(expectedAssistantText([camel, snake])).toBe('驼蛇')
  })

  it('反例：顺序必须影响结果（否则"顺序"这一判据是空转）', () => {
    expect(expectedAssistantText([rawText('甲'), rawText('乙')]))
      .not.toBe(expectedAssistantText([rawText('乙'), rawText('甲')]))
  })

  it('反例：漏读一段就会被发现（少算文本时结果必须不同）', () => {
    expect(expectedAssistantText([rawText('甲'), rawText('乙')])).not.toBe(expectedAssistantText([rawText('甲')]))
  })

  it('边界：非文本 wire 不计入（工具/状态/终态不得污染期望值）', () => {
    const wires = [rawUser('问'), { source: 'local:s1', update: { sessionUpdate: 'done' } }, rawText('甲')]
    expect(expectedAssistantText(wires)).toBe('甲')
    expect(expectedUserTexts(wires)).toEqual(['问'])
  })
})

// --- oracle 2：多形态等价断言 ---

describe('oracle 自检 · expectReplayInvariants 会因等价性破裂而变红', () => {
  const wires = [rawUser('问'), rawText('甲'), rawText('乙'), { source: 'local:s1', update: { sessionUpdate: 'done' } }]
  const good = chunkRows(wires)

  it('正例：同一行集的两份副本通过', () => {
    expect(() => expectReplayInvariants([
      { name: 'a', rows: good },
      { name: 'b', rows: good.map(row => ({ ...row })) },
    ])).not.toThrow()
  })

  it('反例：某形态丢了一段正文必须变红', () => {
    const lossy = good.filter(row => !(row.eventType === 'assistant.text.delta' && row.sequence === 3))
    expect(() => expectReplayInvariants([
      { name: '完整', rows: good },
      { name: '丢一段', rows: lossy },
    ])).toThrow()
  })

  it('反例：某形态的时间戳被改必须变红（边界一致不是摆设）', () => {
    const doctored = good.map(row => row.eventType === 'turn.completed' ? { ...row, occurredAt: '2030-01-01T00:00:00.000Z' } : row)
    expect(() => expectReplayInvariants([
      { name: '原样', rows: good },
      { name: '改时间戳', rows: doctored },
    ])).toThrow()
  })

  it('反例：某形态出现 sequence 空洞必须变红', () => {
    const withHole = good.filter(row => row.sequence !== 2)
    expect(() => expectReplayInvariants([
      { name: '原样', rows: good },
      { name: '有空洞', rows: withHole },
      { name: '原样副本', rows: good.map(row => ({ ...row })) },
    ])).toThrow()
  })

  it('单形态调用必须直接拒绝（无法比较等价性）', () => {
    expect(() => expectReplayInvariants([{ name: 'only', rows: good }])).toThrow()
  })
})

// --- oracle 3：sequence 空间 ---

describe('oracle 自检 · inspectSequenceSpace 会叫', () => {
  const rows = chunkRows(SCENARIOS[0]!.wires)

  it('正例：完好行集三项异常均为空', () => {
    const report = inspectSequenceSpace(rows)
    expect([report.occupiedOverlaps, report.holes, report.coveredOutOfBounds]).toEqual([[], [], []])
  })

  it('反例：删行（不重编号）必须报空洞', () => {
    expect(inspectSequenceSpace(rows.filter(row => row.sequence !== 2)).holes).toEqual([2])
  })

  it('反例：两条行声明同一占用必须报重叠', () => {
    const duplicated = [...rows, { ...rows[1]! }]
    expect(inspectSequenceSpace(duplicated).occupiedOverlaps.length).toBeGreaterThan(0)
  })
})
