/**
 * 重放测试的场景 fixture 与「多形态派生」。
 *
 * ## 核心思路：等价性的 oracle 是「形态互等」，不是硬编码期望值
 *
 * 一段逻辑会话可以有不同的物理存储形态，它们**必须重放出同一个会话**：
 *
 * | 形态 | 来源 | 说明 |
 * | --- | --- | --- |
 * | `perChunk` | 今天的生产形态 | 每 chunk 一行 |
 * | `aggregated` | `mergeAdjacentDeltaChunks` | 相邻同类同 identity 的 delta 合成一条聚合行 |
 * | `unitFolded` | `toUnitRows(…, keepCovered: false)` | 已 L3 裁剪：只剩 `turn.unit` |
 * | `unitMixed` | `toUnitRows(…, keepCovered: true)` | **未裁剪的混合态**：单元 + 它覆盖的行仍在 |
 *
 * 于是"任意场景"的等价性可以自动检验，而不必为每个场景手写期望值——写错期望值会把
 * 缺陷固化成契约，golden 文件则会随 fixture 变动腐化。
 *
 * ## 一处必须说清的边界
 *
 * 生产端的折叠在 Rust（`turn_rollup.rs`），本文件的 `foldForFixture` 只是**构造测试输入**
 * 的参考实现，刻意不复刻 sha256（TS 读侧不校验它）。因此
 * **"构建期 sha256 == 重折叠结果"这条等价性属于 Rust 测试**，不在本目录断言——
 * 详见 spec 的 E3。另外单元行会额外占用一个 sequence（`terminal.sequence + 1`），
 * 故单元形态的 sequence 空间与逐 chunk 形态不同，本目录的 sequence 不变量按形态各自检验。
 */
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch.ts'
import { hasCanonicalTurnTerminal } from '../../domains/events/canonicalTurnDuration.ts'
import type { CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import type { ReplayVariant } from './invariants.ts'
import {
  OWNER_KEY,
  chunkRows,
  rawCommands,
  rawDone,
  rawFailed,
  rawMarkdown,
  rawText,
  rawThinking,
  rawToolStart,
  rawUsage,
  rawUser,
  unitRowOf,
} from './harness.ts'

export interface Scenario {
  readonly name: string
  readonly wires: readonly unknown[]
}

export function scenarioOf(name: string, wires: readonly unknown[]): Scenario {
  return { name, wires }
}

// --- 手写场景：覆盖真实会话里会出现的交错与边界 ---

export const SCENARIOS: readonly Scenario[] = [
  scenarioOf('单回合·纯文本', [
    rawUser('问题'),
    rawText('甲'),
    rawText('乙'),
    rawDone(),
  ]),
  scenarioOf('单回合·思考夹在文本中间（run 被切断）', [
    rawUser('问题'),
    rawText('甲'),
    rawThinking('思一'),
    rawThinking('思二'),
    rawText('乙'),
    rawText('丙'),
    rawDone(),
  ]),
  scenarioOf('单回合·工具卡切断 run', [
    rawUser('问题'),
    rawText('甲'),
    rawToolStart('tool-1'),
    rawText('乙'),
    rawDone(),
  ]),
  scenarioOf('单回合·含 markdown 与 Unicode', [
    rawUser('问题'),
    rawText('```js\nconst a = 1\n```'),
    rawText('中文🙂与 emoji 组合 👨‍👩‍👧'),
    rawDone(),
  ]),
  scenarioOf('单回合·空文本 chunk 混在 run 中', [
    rawUser('问题'),
    rawText('甲'),
    rawText(''),
    rawText('乙'),
    rawDone(),
  ]),
  scenarioOf('单回合·思考与文本交替多次', [
    rawUser('问题'),
    rawThinking('思一'),
    rawText('甲'),
    rawThinking('思二'),
    rawText('乙'),
    rawThinking('思三'),
    rawText('丙'),
    rawDone(),
  ]),
  scenarioOf('多回合·第二回合带工具', [
    rawUser('问题一'),
    rawText('答一'),
    rawDone(),
    rawUser('问题二'),
    rawThinking('思二'),
    rawText('答二'),
    rawToolStart('tool-2'),
    rawText('答二续'),
    rawDone(),
  ]),
]

// --- 确定性生成器：长出人工想不到的组合 ---

/** 线性同余，固定种子 ⇒ 可复现（不引入 flaky）。 */
function makeRandom(seed: number): () => number {
  let state = (seed * 1103515245 + 12345) % 2147483648
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

const RUN_TEXTS = ['甲', '乙丙', '', '中', 'x', '```md\ncode\n```', '🙂', ' 空格 ', '多字节中文片段']

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!
}

/**
 * 生成一段会话：1–3 个回合，每回合由随机的 text/thinking/tool run 组成。
 *
 * 刻意纳入四类真实形态（它们各自都是一个"会踩"的边界）：
 * - **identity 抖动**：messageId 中途变化 ⇒ 合并必须以 identity 为界；
 * - **回合中途的状态行**（usage/commands）⇒ 必须切断 delta run；
 * - **markdown 内容**⇒ run 的 markdown 标记与投影 part kind；
 * - **失败终态**（turn.failed）⇒ 与 done 不同的终态路径。
 */
export function generateScenario(seed: number): Scenario {
  const random = makeRandom(seed)
  const wires: unknown[] = []
  const turns = 1 + Math.floor(random() * 3)
  for (let turn = 0; turn < turns; turn += 1) {
    wires.push(rawUser(`问题 ${seed}-${turn}`))
    const runs = 1 + Math.floor(random() * 4)
    for (let run = 0; run < runs; run += 1) {
      const kind = random()
      const chunks = 1 + Math.floor(random() * 3)
      const messageId = `msg-${seed}-${turn}-${Math.floor(random() * 2)}`
      if (kind < 0.4) {
        for (let index = 0; index < chunks; index += 1) wires.push(rawText(pick(random, RUN_TEXTS), messageId))
      } else if (kind < 0.7) {
        for (let index = 0; index < chunks; index += 1) wires.push(rawThinking(pick(random, RUN_TEXTS), messageId))
      } else if (kind < 0.8) {
        wires.push(rawMarkdown('**加粗** 与 `code`', messageId))
      } else if (kind < 0.9) {
        wires.push(rawToolStart(`tool-${seed}-${turn}-${run}`))
      } else {
        wires.push(random() < 0.5 ? rawUsage(1_000_000, 1234) : rawCommands())
      }
    }
    wires.push(random() < 0.2 ? rawFailed() : rawDone())
  }
  return scenarioOf(`生成(seed=${seed})`, wires)
}

export function generateScenarios(count: number): readonly Scenario[] {
  return Array.from({ length: count }, (_, index) => generateScenario(index + 1))
}

// --- 多形态派生 ---

/**
 * 把逐 chunk 行折成单元形态。
 *
 * `keepCovered: true` 产出**未裁剪的混合态**（单元 + 它覆盖的行仍在）——这是 L3 裁剪
 * 迁移中途的真实状态，也是"覆盖声明不得被当作占用"的现场。
 *
 * 单元行占用 `terminal.sequence + 1`，故本函数会重编号：单元插在两回合之间，后续行依次
 * 后移——与生产端"同事务插入单元"后的 sequence 布局一致。
 *
 * `keepCovered: false`（已裁剪）**不重编号**：单元的 payload 里 `seqStart/seqEnd` 指向
 * 被它覆盖的那些编号，重编号会让两者不一致并凭空造出 sequence 空洞。裁剪后那些编号
 * 由单元的覆盖声明解释，不再需要行。
 */
export function toUnitRows(
  rows: readonly CanonicalConversationEvent[],
  options: { readonly keepCovered: boolean },
): CanonicalConversationEvent[] {
  const output: CanonicalConversationEvent[] = []
  let sequence = 0
  let index = 0
  while (index < rows.length) {
    let end = index
    while (end < rows.length && !hasCanonicalTurnTerminal([rows[end]!])) end += 1
    // 先重编号、再据此构建单元：单元的 payload（seqStart/seqEnd/segments）必须与本轮
    // **重编号后**的编号一致。若用重编号前的行构建，覆盖范围会与实际占用错位，
    // 凭空造出 sequence 空洞（本 harness 的 sequence 不变量正是这样抓到的）。
    const renumbered: CanonicalConversationEvent[] = []
    for (const row of rows.slice(index, end + 1)) {
      sequence += 1
      renumbered.push({ ...row, sequence, eventId: `${OWNER_KEY}#${sequence}` })
    }
    output.push(...renumbered)
    if (end < rows.length) {
      sequence += 1
      output.push(buildUnitForFixture(renumbered, sequence))
    }
    index = end + 1
  }
  return options.keepCovered ? output : output.filter(row => row.eventType === 'turn.unit')
}

/** 参考折叠（只用于构造输入；sha256 由 Rust 侧测试负责，这里给占位串）。 */
function buildUnitForFixture(turnRows: readonly CanonicalConversationEvent[], sequence: number): CanonicalConversationEvent {
  const first = turnRows[0]!
  const terminal = turnRows[turnRows.length - 1]!
  const segments: unknown[] = []
  for (const row of turnRows) {
    const baseType = row.eventType === 'assistant.text.delta.batch'
      ? 'assistant.text.delta'
      : row.eventType === 'assistant.thinking.delta.batch'
        ? 'assistant.thinking.delta'
        : undefined
    if (!baseType) {
      segments.push({ kind: 'event', event: row })
      continue
    }
    const text = String((row.typedPayload as { text?: unknown } | undefined)?.text ?? '')
    const previous = segments[segments.length - 1] as { kind?: string; eventType?: string } | undefined
    const sameRun = previous?.kind === 'delta-run' && previous.eventType === baseType
    if (sameRun) {
      const run = previous as { seqEnd: number; text: string; markdown: boolean }
      run.seqEnd = row.sequence
      run.text += text
      run.markdown ||= JSON.stringify(row.rawPayload).includes('"type":"markdown"')
      continue
    }
    segments.push({
      kind: 'delta-run',
      eventType: baseType,
      seqStart: row.sequence,
      seqEnd: row.sequence,
      ...(row.identity ? { identity: row.identity } : {}),
      text,
      occurredAt: row.occurredAt,
      markdown: JSON.stringify(row.rawPayload).includes('"type":"markdown"'),
    })
  }
  // #199：行级时间戳对齐生产约定——Rust `build_turn_unit_row` 把 unit 的
  // occurredAt/receivedAt 设为其 terminal 的时间戳（时长推导以行级时间戳封边）。
  return {
    ...unitRowOf(sequence, {
      aggregateKind: 'turn-rollup',
      seqStart: first.sequence,
      seqEnd: terminal.sequence,
      foldedCount: turnRows.length,
      foldScheme: 'adjacent-delta-fold-v1',
      contentSha256: 'fixture-only',
      terminal: { eventType: terminal.eventType as 'turn.completed' | 'turn.failed', occurredAt: terminal.occurredAt },
      segments,
    }),
    occurredAt: terminal.occurredAt,
    receivedAt: terminal.receivedAt,
  }
}

/** 一段场景 → 四种物理形态（等价性 oracle 的输入）。 */
export function shapesOf(scenario: Scenario): readonly ReplayVariant[] {
  const perChunk = chunkRows(scenario.wires)
  return [
    { name: `${scenario.name} · 逐 chunk`, rows: perChunk },
    { name: `${scenario.name} · 聚合`, rows: mergeAdjacentDeltaChunks(perChunk) },
    { name: `${scenario.name} · 单元(已裁剪)`, rows: toUnitRows(perChunk, { keepCovered: false }) },
    { name: `${scenario.name} · 单元(未裁剪混合)`, rows: toUnitRows(perChunk, { keepCovered: true }) },
  ]
}
