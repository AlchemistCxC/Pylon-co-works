/**
 * ① 行语义：一行在 sequence 空间上「占用」什么、「覆盖」什么。
 *
 * 库里有两类行会挑战游标「一行 = 一个 sequence」的假设，且跨度语义**相反**：
 * - `*.delta.batch`：`seqSpan` 是**占用**声明——跨度中间的编号没有任何行写入，
 *   读侧按 `owner#(seqStart+i)` 重建原始 chunk。
 * - `turn.unit`：`rollup_*` 是**覆盖**声明——被折叠的那些行在 L3 裁剪前**仍然存在**，
 *   单元自身只占 `terminal.sequence + 1` 这一个编号。
 *
 * 两类误判的代价**不对称**，这是必须分开钉的理由：
 * - 把**占用**当 gap ⇒ 在途回合直接抛 `canonical_gap_unrecoverable`、断流（有错误码）。
 * - 把**覆盖**当占用 ⇒ 游标跳过仍然存在的行 ⇒ **静默丢数据**（无错误码，更危险）。
 *
 * **ADR-0016（2026-09-20 已采用）**放宽了占用半边：跨度占位允许进入**已提交序列**（写侧聚合把
 * 行折叠下移），连续性判据改为「该行的跨度**覆盖**游标下一号」。覆盖半边**一字未改**——
 * `turn.unit` 的 rollup 跨度仍不得被当作占用。
 */
import { describe, expect, it, vi } from 'vitest'
import { CanonicalEventCursor, CanonicalEventCursorError } from '../../infrastructure/events/canonicalEventCursor.ts'
import { OWNER_KEY, batchRow, chunkRow, unitRow } from './harness.ts'

describe('① 行语义 · 聚合行的「占用跨度」', () => {
  // ADR-0016：连续性判据 = 「该行跨度**覆盖**游标下一号」。起点不得晚于游标下一号、
  // 终点必须等于该行 sequence、只对 `*.delta.batch` 生效；覆盖半边见下一个 describe。
  it('跨度覆盖下一号时游标整体推进到跨度末端（不误报 gap）', async () => {
    const span = batchRow(1, 3, ['a', 'b', 'c'])
    const list = vi.fn().mockResolvedValue({ events: [span], nextBeforeSequence: null })
    const cursor = new CanonicalEventCursor({ list })
    const applied: number[] = []

    await cursor.accept(span, row => { applied.push(row.sequence) })

    expect(applied).toEqual([3])
    expect(cursor.cursor(OWNER_KEY)).toBe(3)
  })

  it('游标已 seed 到跨度内部时，同一跨度行仍可整体收口到末端（且不触发补读）', async () => {
    // 恢复场景：游标已确认到 1，行 [1,3] 到来说明 2、3 都由它承载 ⇒ 它就是那个缺号的承载者。
    const span = batchRow(1, 3, ['a', 'b', 'c'])
    const list = vi.fn()
    const cursor = new CanonicalEventCursor({ list })
    cursor.seed(OWNER_KEY, 1)

    await cursor.accept(span, () => {})

    expect(cursor.cursor(OWNER_KEY)).toBe(3)
    expect(list).not.toHaveBeenCalled()
  })

  it('跨度**不覆盖**下一号时仍抛 canonical_gap_unrecoverable（中间确有真空）', async () => {
    // 行 [2,4] 在游标 0 处到达：1 号没有任何行承载 ⇒ 仍是真空，必须报错、不得部分推进。
    const span = batchRow(2, 4, ['b', 'c', 'd'])
    const list = vi.fn().mockResolvedValue({ events: [span], nextBeforeSequence: null })
    const cursor = new CanonicalEventCursor({ list })
    const consume = vi.fn()

    const error = await cursor.accept(span, consume).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(CanonicalEventCursorError)
    expect(error).toMatchObject({ code: 'canonical_gap_unrecoverable' })
    expect(cursor.cursor(OWNER_KEY)).toBe(0)
    expect(consume).not.toHaveBeenCalled()
  })

  it('损坏的聚合行由读边界折叠，不是游标的职责（职责边界须分离）', async () => {
    // 形状不一致（foldedCount=9 vs span 宽度 2）由读边界的 canonicalBatchChunksOf
    // 退回单行归一；游标只看 sequence 与跨度起点/终点。钉住这个职责边界，
    // 防止改造时把"形状折叠"与"连续性推进"两件事混在一起。
    const broken = batchRow(1, 2, ['ab'])
    broken.typedPayload = { text: 'ab', foldedCount: 9, seqSpan: [1, 2] }
    const cursor = new CanonicalEventCursor({ list: vi.fn() })
    cursor.seed(OWNER_KEY, 1)
    const applied: number[] = []

    await cursor.accept(broken, row => { applied.push(row.sequence) })

    expect(applied).toEqual([2])
    expect(cursor.cursor(OWNER_KEY)).toBe(2)
  })
})

describe('① 行语义 · turn.unit 的「覆盖跨度」不得当作占用', () => {
  it('单元行的 rollup 跨度不吞掉仍然存在的被覆盖行', async () => {
    // L3 裁剪前：chunk(1) chunk(2) 仍在，unit(3) 的 rollup 覆盖 [1,2]。
    // 若把 rollup 当占用，游标会跳过 1、2 只消费 3 ⇒ 静默丢两行。
    const cursor = new CanonicalEventCursor({ list: vi.fn() })
    const applied: number[] = []

    for (const row of [chunkRow(1, 'a'), chunkRow(2, 'b'), unitRow(3, 1, 2)]) {
      await cursor.accept(row, consumed => { applied.push(consumed.sequence) })
    }

    expect(applied).toEqual([1, 2, 3])
    expect(cursor.cursor(OWNER_KEY)).toBe(3)
  })

  it('单元行只推进一个 sequence（自身），不按 rollup 宽度推进', async () => {
    const cursor = new CanonicalEventCursor({ list: vi.fn() })
    cursor.seed(OWNER_KEY, 2)

    await cursor.accept(unitRow(3, 1, 2), () => {})

    expect(cursor.cursor(OWNER_KEY)).toBe(3)
  })
})

describe('① 行语义 · 连续性契约的回归保护', () => {
  it('逐 chunk 连续行照常逐条推进（聚合能力不得改变这条路径）', async () => {
    const cursor = new CanonicalEventCursor({ list: vi.fn() })
    const applied: number[] = []

    for (const row of [chunkRow(1, 'a'), chunkRow(2, 'b'), chunkRow(3, 'c')]) {
      await cursor.accept(row, consumed => { applied.push(consumed.sequence) })
    }

    expect(applied).toEqual([1, 2, 3])
    expect(cursor.cursor(OWNER_KEY)).toBe(3)
  })
})
