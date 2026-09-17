/**
 * 场景矩阵：把「同一会话的多形态等价」从手写小样例推广到全场景。
 *
 * 对每个场景的四形态（逐 chunk / 聚合 / 单元已裁剪 / 单元未裁剪混合）一次性断言五层
 * 不变量（见 `invariants.ts`）。硬编码场景负责"我想得到的情况"，确定性生成器负责
 * "组合出来的情况"（工具卡切在 run 中间、run 边界上的空文本、identity 抖动、多回合交错）。
 *
 * 之所以能这样做，是因为 oracle 是**形态互等**而非期望值：新增场景不需要新增期望值，
 * 因此不会出现"写错的期望值把缺陷固化成契约"。
 *
 * 注意一条不能由本文件证明的等价性：**构建期 sha256 == 重折叠结果**在 Rust 侧
 * （折叠是 `turn_rollup.rs`，本目录的 `foldForFixture` 只是构造输入用的参考实现）。
 */
import { describe, expect, it } from 'vitest'
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch.ts'
import { SCENARIOS, generateScenarios, shapesOf, toUnitRows } from './fixtures.ts'
import { expectReplayInvariants, inspectSequenceSpace } from './invariants.ts'
import { chunkRows } from './harness.ts'

const GENERATED = generateScenarios(24)

describe('场景矩阵 · 多形态等价与跨层不变量', () => {
  for (const scenario of SCENARIOS) {
    it(`手写场景：${scenario.name}`, () => {
      expectReplayInvariants(shapesOf(scenario))
    })
  }

  for (const scenario of GENERATED) {
    it(`生成场景：${scenario.name}`, () => {
      expectReplayInvariants(shapesOf(scenario))
    })
  }
})

describe('场景矩阵 · 派生形态自身的形状约束', () => {
  for (const scenario of [...SCENARIOS, ...GENERATED].slice(0, 8)) {
    it(`单元形态确实产出了单元行：${scenario.name}`, () => {
      const rows = toUnitRows(chunkRows(scenario.wires), { keepCovered: false })
      // 若某场景根本没折出单元，等价性断言就是空转——先钉住"聚合确实发生"。
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(row => row.eventType === 'turn.unit')).toBe(true)
    })
  }

  it('未裁剪混合态同时含单元行与被覆盖行（这正是 L3 迁移中途的现场）', () => {
    const perChunk = chunkRows(SCENARIOS[0]!.wires)
    const mixed = toUnitRows(perChunk, { keepCovered: true })
    expect(mixed.some(row => row.eventType === 'turn.unit')).toBe(true)
    expect(mixed.some(row => row.eventType !== 'turn.unit')).toBe(true)
    expect(mixed.length).toBe(perChunk.length + 1)
  })
})

describe('场景矩阵 · sequence 空间不变量（静默丢数据的唯一结构性防线）', () => {
  it('逐 chunk 形态：占用逐条、无重叠、无空洞', () => {
    const report = inspectSequenceSpace(chunkRows(SCENARIOS[6]!.wires))
    expect(report.occupiedOverlaps).toEqual([])
    expect(report.holes).toEqual([])
    expect(report.revision).toBe(SCENARIOS[6]!.wires.length)
  })

  it('聚合形态：跨度整体占用，中间编号由跨度解释而非缺失', () => {
    const aggregated = mergeAdjacentDeltaChunks(chunkRows(SCENARIOS[1]!.wires))
    expect(aggregated.some(row => row.eventType.endsWith('.batch'))).toBe(true)
    // 注意必须对**完整**行集检验：若只挑出 batch 行，被丢掉的 user 行与未聚合的单条 run
    // 会立刻表现为空洞——那是对断言取材的错误，不是数据问题。
    const report = inspectSequenceSpace(aggregated)
    expect(report.occupiedOverlaps).toEqual([])
    expect(report.holes).toEqual([])
    expect(report.revision).toBe(SCENARIOS[1]!.wires.length)
  })

  it('已裁剪形态：被覆盖编号由单元的覆盖声明解释，不得算作空洞', () => {
    const trimmed = toUnitRows(chunkRows(SCENARIOS[6]!.wires), { keepCovered: false })
    const report = inspectSequenceSpace(trimmed)
    expect(report.holes).toEqual([])
    expect(report.coveredOutOfBounds).toEqual([])
  })

  it('防线自检：故意制造空洞时必须被检出（否则这条不变量是空转）', () => {
    const rows = chunkRows(SCENARIOS[0]!.wires)
    // 直接删掉中间一行且**不重编号** ⇒ [1..revision] 出现空洞，必须被抓到。
    // （若顺手重编号，空洞会被填平，这条自检就成了空转——第一版就是这么写错的。）
    const withHole = rows.filter(row => row.sequence !== 2)
    const report = inspectSequenceSpace(withHole)
    expect(report.holes).toEqual([2])
    expect(report.occupiedOverlaps).toEqual([])
  })

  it('防线自检：故意制造占用重叠时必须被检出', () => {
    const rows = chunkRows(SCENARIOS[0]!.wires)
    // 让第 3 行也声明占用 [2,3]（模拟一条错误的聚合行跨度）
    const overlapping = rows.map(row => row.sequence === 3
      ? { ...row, eventType: 'assistant.text.delta.batch' as const, typedPayload: { text: 'x', foldedCount: 2, seqSpan: [2, 3] }, rawPayload: [row.rawPayload, row.rawPayload] }
      : row)
    const report = inspectSequenceSpace(overlapping)
    expect(report.occupiedOverlaps).toContain(2)
  })
})
