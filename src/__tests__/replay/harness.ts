/**
 * 重放契约套件的共享 harness 与索引。
 *
 * ## 这个目录是什么
 *
 * 重放的正确性由**四层契约**共同保证。它们原本散在 domain / infrastructure /
 * components / sheets 四处的十几个文件里，改动时看不出风险面；现按功能收集到本目录
 * （跨层测试的既有先例见 `src/__tests__/`）。
 *
 * ### 本目录新增的跨层契约（按功能分文件）
 *
 * - `rowSemantics.test.ts`        — ① 一行在 sequence 空间上「占用」什么、「覆盖」什么
 * - `granularityIndependence.test.ts` — ② 回合边界推导不得依赖 delta 的行粒度
 * - `inFlightBaseline.test.ts`    — ③ 无终态行的在途回合必须可完整重放
 * - `crossLayerComposition.test.ts` — ④ 同一输入在多种形态下，三层观测量彼此一致
 *
 * ### 收进来的既有契约（断言一字未改，仅路径与相对导入重算）
 *
 * - 行语义细目：`canonicalEventSink.batch`（写入侧合并规则）
 * - 游标连续性：`canonicalEventCursor`
 * - 帧入口与 durable-before-project：`canonicalEventFeed`
 * - 归一化与投影：`canonicalNormalizer`、`canonicalUnit`、`messageProjection`、
 *   `messageProjection.batchEquivalence`、`messageProjectionCharacterization`
 * - 回合边界推导：`canonicalTurnDuration`
 * - 重放决策矩阵（authority × commit）：`chatReplayCoordinator`、`replayCrossLineContract`
 * - 会话层展开（batch/unit compact 等价、段级隔离、rebind、快照桥）：
 *   `agentWorkbenchSession.batch`、`agentWorkbenchSession.rebindIndicator`、
 *   `agentWorkbenchSession.snapshotBridge`
 *
 * ### 刻意**未**收进来的（属写入路径 / 会话运行时行为，与重放等价性不同类）
 *
 * - `src/infrastructure/events/__tests__/`：`canonicalEventSink`、`canonicalEventPersistScheduler`、
 *   `canonicalEventRepository`（落盘闸口 / 调度 / 仓库读写——失败语义是"写失败"，不是"重放不等价"）
 * - `src/sheets/agent-workbench/__tests__/`：会话运行时套件（含 `terminalDelivery`，终帧投递）
 *
 * 若要把这些一并收进来是一次纯搬移，但会模糊"写入路径"与"重放契约"的归属，需单独确认。
 *
 * ## 两类断言的区分（重要）
 *
 * - **特征化（绿）**：现状正确 → 钉死。改动若使其变红，即"重放模型被移动"。
 * - **目标声明（todo）**：现状不足 → 声明目标，绝不写"把缺陷钉成契约"的绿断言。
 *
 * 文件名刻意不匹配 `*.test.ts`，故不会被 vitest 收集为测试文件。
 */
import type { CanonicalEventRow } from '../../infrastructure/events/canonicalEventRepository.ts'
import { normalizeRawEvent } from '../../domains/events/canonicalNormalizer.ts'
import type { CanonicalConversationEvent, CanonicalEventOwner, CanonicalEventType } from '../../domains/events/eventSchema.ts'

export const OWNER_KEY = '["p1","peri","local:s1"]'
export const OWNER: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' }
export const AT = '2026-09-18T00:00:00.000Z'
export const START = '2026-09-18T10:00:00.000Z'
export const END = '2026-09-18T10:00:12.500Z'

/** 任意类型的行：eventId 必须等于 `ownerKey#sequence`（validateCanonicalEvent 的口径）。 */
export function baseRow(
  sequence: number,
  eventType: CanonicalEventType,
  typedPayload: unknown,
  rawPayload: unknown,
): CanonicalEventRow {
  return {
    eventId: `${OWNER_KEY}#${sequence}`,
    owner: OWNER,
    clientGeneration: 1,
    sequence,
    occurredAt: AT,
    receivedAt: AT,
    eventType,
    payloadVersion: 1,
    typedPayload,
    rawPayload,
  }
}

/** delta chunk 行（单 sequence）。 */
export function chunkRow(sequence: number, text: string): CanonicalEventRow {
  return baseRow(
    sequence,
    'assistant.text.delta',
    { text },
    { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  )
}

/**
 * 聚合行：占用 [first,last]；`sequence`/`eventId` 取跨度**末条**、`text` 为拼接结果、
 * `rawPayload` 为原始 chunk 数组——沿用 `canonicalEventBatch.buildBatchRow` 的规则。
 */
export function batchRow(first: number, last: number, texts: readonly string[]): CanonicalEventRow {
  return baseRow(
    last,
    'assistant.text.delta.batch',
    { text: texts.join(''), foldedCount: texts.length, seqSpan: [first, last] },
    texts.map(text => ({
      source: 'local:s1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })),
  )
}

/** turn.unit 行：`rollup_*` 是**覆盖**声明（被折叠的行在裁剪前仍然存在）。 */
export function unitRow(sequence: number, seqStart: number, seqEnd: number): CanonicalEventRow {
  return baseRow(sequence, 'turn.unit', { seqStart, seqEnd }, { kind: 'turn-unit' })
}

// --- 原始 wire 构造（经 normalizeRawEvent 与真实落盘管线同源）---

export function rawText(text: string, messageId = 'msg-1'): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId } }
}
export function rawThinking(text: string, messageId = 'msg-1'): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId } }
}
export function rawUser(text: string): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}
export function rawDone(): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'done' } }
}

/** 按到达顺序归一为逐 chunk canonical 行；每行 `receivedAt` 互不相同（与真实库一致）。 */
export function chunkRows(wires: readonly unknown[]): CanonicalConversationEvent[] {
  return wires.map((raw, index) => normalizeRawEvent(raw, {
    owner: OWNER,
    clientGeneration: 1,
    sequence: index + 1,
    receivedAt: new Date(Date.UTC(2026, 8, 18, 0, 0, 0) + index).toISOString(),
  }).event)
}

/** 助手侧 run 的正文序列（投影形状断言用）。 */
export function assistantRuns(messages: readonly { role: string; content: string }[]): string[] {
  return messages.filter(message => message.role === 'assistant').map(message => message.content)
}

/** 经 normalizeRawEvent 落盘的 canonical 行 → 回合边界推导的输入形状。 */
export function boundaryOf(row: CanonicalConversationEvent) {
  return {
    sequence: row.sequence,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
  }
}

/**
 * 回合边界推导的输入形状。`eventType` 必须是 canonical 事件类型联合（不是裸 string）——
 * 这样"把聚合行误当边界"这类错误才能在类型层就被挡住。
 */
export function boundary(sequence: number, eventType: CanonicalEventType, occurredAt: string) {
  return { sequence, eventType, occurredAt }
}

// --- 共享输入 ---

/** 在途回合：user + 交错的 text/thinking delta，**没有** done/terminal 行。 */
export const IN_FLIGHT_WIRES = [
  rawUser('问题'),
  rawText('甲'),
  rawThinking('思一'),
  rawThinking('思二'),
  rawText('乙'),
  rawText('丙'),
]

/** 完整回合（含终态）：用于跨层组合。 */
export const COMPOSED_WIRES = [rawUser('问题'), rawText('甲'), rawText('乙'), rawText('丙'), rawDone()]

/** 同一逻辑回合的四种存储形态（回合边界推导用；delta 粒度只影响前两种）。 */
export const STORAGE_SHAPES = [
  ['逐 chunk', [
    boundary(1, 'user.message', START),
    boundary(2, 'assistant.thinking.delta', START),
    boundary(3, 'assistant.text.delta', START),
    boundary(4, 'assistant.text.delta', START),
    boundary(5, 'assistant.thinking.delta', START),
    boundary(6, 'assistant.text.delta', START),
    boundary(7, 'turn.completed', END),
  ]],
  ['已聚合', [
    boundary(1, 'user.message', START),
    boundary(4, 'assistant.text.delta.batch', START),
    boundary(5, 'assistant.thinking.delta.batch', START),
    boundary(6, 'assistant.text.delta.batch', START),
    boundary(7, 'turn.completed', END),
  ]],
  ['已裁剪', [
    boundary(1, 'user.message', START),
    boundary(7, 'turn.completed', END),
  ]],
  ['仅单元行', [
    boundary(1, 'user.message', START),
    boundary(8, 'turn.unit', END),
  ]],
] as const
