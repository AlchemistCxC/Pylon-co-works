/**
 * #376/#375 的合成语料：**一个完整回合**的 canonical 行（与开发记录 §复现方法同一配方）。
 *
 * `user_message_chunk` → `calls` ×（`tool_call` + `beats` × `tool_call_update`，content
 * **逐拍累计**至 `finalBytes`）→ `usage_update` → `done`。
 *
 * 三条硬约束（照抄记录里的两个坑 + 一条量纲口径）：
 * 1. 必须构成完整回合——缺 user 起始帧时工具事件会被终态栅栏判为 late-event 整批丢弃；
 * 2. 事件类型由 `update.sessionUpdate` 推导，不由入参决定（故这里走生产归一化器）；
 * 3. 走**前端 append 轨**的等价形状：没有 turn.unit 行（单元只由 kernel ingest 追加），
 *    因此 compact 读会把全部行下发——这正是要量的形状。
 */
import { normalizeRawEvent } from '../../../src/domains/events/canonicalNormalizer.ts'
import type { CanonicalConversationEvent, CanonicalEventOwner } from '../../../src/domains/events/eventSchema.ts'

export interface MemoryCorpusOptions {
  readonly calls?: number
  readonly beats?: number
  /** 每次调用最后一拍累计到的 content 字符数（逐拍线性累计）。 */
  readonly finalBytes?: number
  readonly owner?: CanonicalEventOwner
}

export interface MemoryCorpus {
  readonly owner: CanonicalEventOwner
  readonly rows: readonly CanonicalConversationEvent[]
  /** Σ**逻辑载荷**：各拍累计 content 的字符数之和（与记录 61.5 MB 同一口径）。 */
  readonly logicalPayloadBytes: number
  readonly calls: number
  readonly beats: number
}

const DEFAULT_OWNER: CanonicalEventOwner = {
  profileId: 'perf',
  agentId: 'peri',
  localSessionId: 'local:mem',
}

export function buildMemoryCorpus(options: MemoryCorpusOptions = {}): MemoryCorpus {
  const calls = options.calls ?? 100
  const beats = options.beats ?? 20
  const finalBytes = options.finalBytes ?? 60_000
  const owner = options.owner ?? DEFAULT_OWNER
  const wires: unknown[] = [
    { update: { sessionUpdate: 'user_message_chunk', content: { text: '跑一遍内存语料' } } },
  ]
  let logicalPayloadBytes = '跑一遍内存语料'.length
  for (let call = 0; call < calls; call += 1) {
    const toolCallId = `call-${call}`
    wires.push({
      update: { sessionUpdate: 'tool_call', toolCallId, title: 'Bash', kind: 'execute', status: 'in_progress' },
    })
    for (let beat = 1; beat <= beats; beat += 1) {
      const size = Math.round((finalBytes * beat) / beats)
      logicalPayloadBytes += size
      wires.push({
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: beat === beats ? 'completed' : 'in_progress',
          // 累计式回传：每一拍带**到此为止**的全部输出（这正是拍数敏感性的来源）
          rawOutput: { type: 'text', text: 'x'.repeat(size) },
        },
      })
    }
  }
  wires.push({ update: { sessionUpdate: 'usage_update', size: 200_000, used: 12_345 } })
  wires.push({ update: { sessionUpdate: 'done', stopReason: 'end_turn' } })

  const rows = wires.map((raw, index) => normalizeRawEvent(raw, {
    owner,
    clientGeneration: 1,
    sequence: index + 1,
    receivedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, 0) + index * 10).toISOString(),
  }).event)

  return { owner, rows, logicalPayloadBytes, calls, beats }
}
