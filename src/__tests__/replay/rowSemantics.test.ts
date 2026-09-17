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
 */
import { describe, expect, it, vi } from 'vitest'
import { CanonicalEventCursor, CanonicalEventCursorError } from '../../infrastructure/events/canonicalEventCursor.ts'
import { OWNER_KEY, batchRow, chunkRow, unitRow } from './harness.ts'

describe('① 行语义 · 聚合行的「占用跨度」', () => {
  it('现状：跨度行让游标抛 canonical_gap_unrecoverable（中间编号无行可补）', async () => {
    // 这是本次要改掉的行为，先钉住现状，使改动的翻转点只有一个断言。
    const span = batchRow(1, 3, ['a', 'b', 'c'])
    const list = vi.fn().mockResolvedValue({ events: [span], nextBeforeSequence: null })
    const cursor = new CanonicalEventCursor({ list })
    const consume = vi.fn()

    const error = await cursor.accept(span, consume).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(CanonicalEventCursorError)
    expect(error).toMatchObject({ code: 'canonical_gap_unrecoverable' })
    // 不得部分推进：跨度未整体到位时游标必须停在原处
    expect(cursor.cursor(OWNER_KEY)).toBe(0)
    expect(consume).not.toHaveBeenCalled()
  })

  it('现状：补读也救不回来（补读返回的仍是跨度行自身）', async () => {
    const span = batchRow(2, 4, ['b', 'c', 'd'])
    const list = vi.fn().mockResolvedValue({ events: [span], nextBeforeSequence: null })
    const cursor = new CanonicalEventCursor({ list })
    cursor.seed(OWNER_KEY, 1)

    const error = await cursor.accept(span, () => {}).catch((value: unknown) => value)

    expect(error).toMatchObject({ code: 'canonical_gap_unrecoverable' })
    expect(cursor.cursor(OWNER_KEY)).toBe(1)
    expect(list).toHaveBeenCalled()
  })

  it.todo('目标：跨度行 [first,last] 整体到位时应把游标推进到 last 且不误报 gap（T1 落地后启用）')

  it('损坏的聚合行由读边界折叠，不是游标的职责（职责边界须分离）', async () => {
    // 形状不一致（foldedCount=9 vs span 宽度 2）由读边界的 canonicalBatchChunksOf
    // 退回单行归一；游标只看 sequence 与合法性校验。钉住这个职责边界，
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
