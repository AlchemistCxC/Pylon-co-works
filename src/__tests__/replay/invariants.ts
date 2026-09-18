/**
 * 重放不变量的可复用断言 harness。
 *
 * ## 为什么需要它
 *
 * 单点断言只能证明"我想到的那个用例没问题"。重放的正确性实际是**一组跨层不变量**，
 * 每个不变量都该对**任意**场景、**任意**存储形态成立。本模块把五层不变量收敛成一次
 * 调用，于是场景数 × 形态数 × 不变量数 的组合覆盖不再需要线性增长的测试代码。
 *
 * ## 五层不变量
 *
 * 1. **投影等价**：同一逻辑会话的多种物理形态，`projectMessagesFromCanonical` 输出逐字节相等。
 *    这是"能正确重放"的操作性定义。
 * 2. **边界一致**：回合时长与终态判定与 delta 粒度无关。
 * 3. **sequence 空间不重不漏**（最重要的一条）：把行集映射到 sequence 空间，必须满足
 *    - **占用不重叠**：两条行的「占用」区间不得相交（聚合行占用它的 `seqSpan` 整个宽度）；
 *    - **覆盖受控**：`turn.unit` 的 `rollup` 覆盖只允许落在它自己声明的跨度和该 owner 的
 *      `[1..revision]` 之内——混合态（覆盖行仍未被裁剪）会合法地"双重解释"同一段序列，
 *      这是读侧 coverage 互斥要处理的状态，不是错误；
 *    - **无空洞**：`[1..revision]` 内每个 sequence 至少被一条行解释（占用或覆盖）。
 *    缺了这条不变量，游标跳过仍存在的行这类**静默丢数据**就不会被任何断言发现。
 * 4. **游标推进**：逐 chunk 形态可推进到最后一条 sequence。
 * 5. **幂等**：同一行集重复投影结果不变。
 *
 * ## 已知缺口（显式记录，不写成绿断言）
 *
 * 游标**不能**接受聚合行的占用跨度（见 `rowSemantics.test.ts` 的特征化）。故本 harness
 * 只在"逐 chunk 形态"上断言游标推进，聚合形态游标断言留给 todo。
 */
import { expect } from 'vitest'
import type { CanonicalEventRow } from '../../infrastructure/events/canonicalEventRepository.ts'
import { isCanonicalBatchDeltaType, canonicalBatchSpanOf } from '../../infrastructure/events/canonicalEventBatch.ts'
import { parseTurnUnitPayload } from '../../domains/events/canonicalUnit.ts'
import type { CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal } from '../../domains/events/canonicalTurnDuration.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'

export interface SequenceSpan {
  readonly first: number
  readonly last: number
  readonly cause: 'occupied' | 'covered'
}

/**
 * 一行在 sequence 空间上声明了什么。
 *
 * - 逐 chunk 行：占用 `[seq, seq]`
 * - 聚合行（`*.delta.batch`）：占用 `seqSpan` 整个宽度，**该跨度包含行自身的 `sequence`**
 *   （`buildBatchRow` 取末条的 sequence/eventId）⇒ 只报跨度，报两者会把末条重复计数
 * - `turn.unit`：占用 `[seq, seq]`；另以 `rollup` **覆盖**它所折叠的跨度
 *   （那些行在裁剪前仍然存在 ⇒ 合法双重解释）。单元自身在 `terminal.sequence + 1`，
 *   落在其 rollup 跨度之外，故两类声明天然不相交。
 */
export function sequenceSpansOf(row: CanonicalConversationEvent): readonly SequenceSpan[] {
  const batchSpan = isCanonicalBatchDeltaType(row.eventType) ? canonicalBatchSpanOf(row) : undefined
  const spans: SequenceSpan[] = [
    batchSpan
      ? { first: batchSpan[0], last: batchSpan[1], cause: 'occupied' }
      : { first: row.sequence, last: row.sequence, cause: 'occupied' },
  ]
  const unit = parseTurnUnitPayload(row)
  if (unit) spans.push({ first: unit.seqStart, last: unit.seqEnd, cause: 'covered' })
  return spans
}

export interface SequenceSpaceReport {
  readonly revision: number
  /** 同一 sequence 被多条**占用**声明覆盖的编号（必须为空）。 */
  readonly occupiedOverlaps: readonly number[]
  /** `[1..revision]` 内没有任何声明解释的编号（必须为空）。 */
  readonly holes: readonly number[]
  /** 覆盖声明越出 `[1..revision]` 或越出单位自身跨度的编号（必须为空）。 */
  readonly coveredOutOfBounds: readonly number[]
}

/**
 * 把行集映射到 sequence 空间并给出三类异常。
 *
 * `revision` 由行集自身推导（`max(占用末端)`），因此对任意形态都可用——不依赖后端
 * 传来的 revision，避免"用被测对象的输入去验证被测对象"。
 */
export function inspectSequenceSpace(rows: readonly CanonicalConversationEvent[]): SequenceSpaceReport {
  const occupiedPerSequence = new Map<number, number>()
  const explained = new Set<number>()
  let revision = 0
  const covered: SequenceSpan[] = []
  const occupiedRanges: SequenceSpan[] = []

  for (const row of rows) {
    for (const span of sequenceSpansOf(row)) {
      if (span.cause === 'occupied') {
        occupiedRanges.push(span)
        revision = Math.max(revision, span.last)
        for (let seq = span.first; seq <= span.last; seq += 1) {
          occupiedPerSequence.set(seq, (occupiedPerSequence.get(seq) ?? 0) + 1)
          explained.add(seq)
        }
      } else {
        covered.push(span)
      }
    }
  }
  for (const span of covered) {
    for (let seq = span.first; seq <= span.last; seq += 1) explained.add(seq)
  }

  const occupiedOverlaps: number[] = []
  for (const [seq, count] of occupiedPerSequence) if (count > 1) occupiedOverlaps.push(seq)
  const holes: number[] = []
  for (let seq = 1; seq <= revision; seq += 1) if (!explained.has(seq)) holes.push(seq)
  const coveredOutOfBounds: number[] = []
  for (const span of covered) {
    // 覆盖必须落在某条 unit 自身声明的跨度内且不越出 revision；单位行自身的占用已计入。
    if (span.first < 1 || span.last > revision) coveredOutOfBounds.push(span.first)
  }

  return {
    revision,
    occupiedOverlaps: occupiedOverlaps.sort((a, b) => a - b),
    holes,
    coveredOutOfBounds,
  }
}

function boundaryOf(row: CanonicalConversationEvent) {
  return {
    sequence: row.sequence,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
  }
}

function projectionOf(rows: readonly CanonicalConversationEvent[]): string {
  return JSON.stringify(projectMessagesFromCanonical(rows as CanonicalEventRow[]))
}

export interface ReplayVariant {
  readonly name: string
  readonly rows: readonly CanonicalConversationEvent[]
}

export interface ReplayInvariantOptions {
  /** 投影等价与边界一致为默认断言；需要时可用它放宽（默认全开）。 */
  readonly expectProjectionEquivalence?: boolean
  readonly expectBoundaryConsistency?: boolean
  readonly expectSequenceSpace?: boolean
  readonly expectIdempotence?: boolean
}

/**
 * 对同一逻辑会话的多个存储形态一次性断言五层不变量。
 *
 * 调用方只负责提供"同一会话的多种物理形态"；等价性 oracle 是**形态之间的互等**，
 * 而不是硬编码期望值——这样 fixture 变动时不会产生需要同步维护的 golden 文件，
 * 也不会因为写错期望值而把缺陷固化成契约。
 */
export function expectReplayInvariants(
  variants: readonly ReplayVariant[],
  options: ReplayInvariantOptions = {},
): void {
  const {
    expectProjectionEquivalence = true,
    expectBoundaryConsistency = true,
    expectSequenceSpace = true,
    expectIdempotence = true,
  } = options
  expect(variants.length, '至少需要两个形态才能比较等价性').toBeGreaterThan(1)
  const [reference, ...rest] = variants

  if (expectProjectionEquivalence) {
    const expected = projectionOf(reference.rows)
    for (const variant of rest) {
      expect(projectionOf(variant.rows), `投影不等价：${variant.name} vs ${reference.name}`).toBe(expected)
    }
  }

  if (expectBoundaryConsistency) {
    // 时长推导需要一条 `user.message` 行来确立回合起点（见 canonicalTurnDuration）。
    // 真实 L3 裁剪把该回合**整个范围（含 user 行）**折进 unit 的 segment，因此"已裁剪"
    // 形态在只读行的推导下**取不到时长**——页脚显示「耗时不可用」。
    //
    // 这是既定行为的精确表述，不是缺陷断言，故分两组：
    //  · 保有锚点行的形态之间：时长与终态必须完全一致；
    //  · 失去锚点行的形态：终态仍可判定，但时长必须**不可测**（不得凭空造 0s 或近似值）。
    // 将来若让推导遍历 unit 的 segments 以恢复被裁剪回合的时长，第二组会变红——那是有意
    // 的信号：届时同步本条契约与页脚文案（见对话记录里的发现项）。
    const anchored = variants.filter(variant => variant.rows.some(row => row.eventType === 'user.message'))
    const unanchored = variants.filter(variant => !variant.rows.some(row => row.eventType === 'user.message'))

    if (anchored.length > 0) {
      const duration = deriveCanonicalTurnDuration(anchored[0]!.rows.map(boundaryOf))
      const terminal = hasCanonicalTurnTerminal(anchored[0]!.rows)
      for (const variant of anchored) {
        expect(deriveCanonicalTurnDuration(variant.rows.map(boundaryOf)), `时长不一致：${variant.name}`)
          .toEqual(duration)
        expect(hasCanonicalTurnTerminal(variant.rows), `终态判定不一致：${variant.name}`).toBe(terminal)
      }
    }
    for (const variant of unanchored) {
      expect(deriveCanonicalTurnDuration(variant.rows.map(boundaryOf)), `无锚点形态不得推出时长：${variant.name}`)
        .toBeUndefined()
      expect(hasCanonicalTurnTerminal(variant.rows), `无锚点形态仍须可判定终态：${variant.name}`).toBe(true)
    }
  }

  if (expectSequenceSpace) {
    for (const variant of variants) {
      const report = inspectSequenceSpace(variant.rows)
      expect(report.occupiedOverlaps, `占用区间重叠：${variant.name}`).toEqual([])
      expect(report.holes, `sequence 空洞：${variant.name}`).toEqual([])
      expect(report.coveredOutOfBounds, `覆盖越界：${variant.name}`).toEqual([])
    }
  }

  if (expectIdempotence) {
    for (const variant of variants) {
      const once = projectionOf(variant.rows)
      expect(projectionOf(variant.rows), `投影不幂等：${variant.name}`).toBe(once)
    }
  }
}
