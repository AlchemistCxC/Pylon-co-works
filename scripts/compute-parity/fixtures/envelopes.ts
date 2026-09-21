// workbench 语义 envelope 生成器（投影套件的输入面）。
//
// envelope 构造口径照抄 `src/domains/workbench/__tests__/projectorComputeParity.test.ts`
// 的 `envelope()` helper；事件载荷形状同该测试的混合流语料（message/reasoning/tool/
// interaction/diagnostic/session/event.unknown 全族覆盖，投影归约器矩阵的每个
// 切片都至少被一条生成流触碰）。

import {
  createWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
  type WorkbenchSemanticEvent,
} from '../../../src/domains/workbench/events/workbenchEventSchema.ts'

export const SESSION_ID = 'compute-parity'
export const RECORDED_AT = '2026-09-21T00:00:00.000Z'

export function envelope(
  sequence: number,
  event: WorkbenchSemanticEvent,
  identity: WorkbenchEventEnvelope['identity'] = {},
  provenance: WorkbenchEventEnvelope['provenance'] = { origin: 'local-observed', trust: 'authoritative' },
  coverage?: readonly [number, number],
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId: SESSION_ID,
    sequence,
    recordedAt: RECORDED_AT,
    source: { provider: 'peri', sourceId: `wire-${sequence}` },
    identity,
    provenance,
    ...(coverage ? { coverage } : {}),
    event,
  })
}

/**
 * 冷重放式 journal：1 条 user 开场 + `total` 条 reasoning delta（热路径：
 * 单文本部件零 JSON 通道）。形状与 `scripts/bench-ts-vs-wasm.mts` 的 journal 一致。
 */
export function deltaJournal(total: number): WorkbenchEventEnvelope[] {
  const events: WorkbenchEventEnvelope[] = [
    envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: '长思考' }] }, { messageId: 'user-perf' }),
  ]
  for (let index = 0; index < total; index += 1) {
    events.push(envelope(
      index + 2,
      { type: 'reasoning.delta', parts: [{ kind: 'thinking', text: `第${index}段思考内容` }] },
      { messageId: 'thought-perf' },
      { origin: 'local-observed', trust: 'authoritative' },
      [index + 2, index + 2],
    ))
  }
  return events
}

/** 混合流 journal：`blocks` 轮对话，每轮覆盖 message/reasoning/tool/diagnostic/session 全族。 */
export function mixedJournal(blocks: number): WorkbenchEventEnvelope[] {
  const events: WorkbenchEventEnvelope[] = []
  let sequence = 0
  const next = (event: WorkbenchSemanticEvent, identity: WorkbenchEventEnvelope['identity'] = {}): void => {
    sequence += 1
    events.push(envelope(sequence, event, identity))
  }
  for (let block = 0; block < blocks; block += 1) {
    const messageId = `m-${block}`
    const toolCallId = `tool-${block}`
    next({ type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: `问题 ${block}` }] }, { messageId: `u-${block}` })
    next({ type: 'reasoning.delta', parts: [{ kind: 'thinking', text: `思考 ${block}` }] }, { messageId: 'r-shared' })
    next({ type: 'message.delta', role: 'assistant', parts: [{ kind: 'markdown', text: `**答案 ${block}**
第二行` }] }, { messageId })
    next({ type: 'tool.started', tool: { toolCallId, name: 'read', semanticKind: 'tool.read', parentActivityId: `act-${block}` } }, { toolCallId })
    next({ type: 'tool.progress', tool: { toolCallId, status: 'running', progress: { step: 2 } } }, { toolCallId })
    next({ type: 'tool.completed', tool: { toolCallId, status: 'completed', durationMs: 120 } }, { toolCallId })
    next({ type: 'interaction.requested', interactionId: `ask-${block}`, request: { question: 'continue?' } }, { interactionId: `ask-${block}` })
    next({ type: 'diagnostic.notice', level: 'info', message: `notice ${block}` })
    next({ type: 'interaction.resolved', interactionId: `ask-${block}`, response: { answer: 'yes' } }, { interactionId: `ask-${block}` })
    next({ type: 'session.status-updated', status: 'running' })
    next({ type: 'message.completed', role: 'assistant', parts: [] }, { messageId })
    if (block % 4 === 3) next({ type: 'event.unknown', originalType: 'future_event', summary: 'future', raw: { block }, truncated: false })
  }
  sequence += 1
  events.push(envelope(sequence, { type: 'session.completed', stopReason: 'end_turn' }))
  return events
}

/** 乱序 coverage 页（#205 覆盖幂等路径）：序列号乱序到达 + 区间覆盖。 */
export function coveragePage(): WorkbenchEventEnvelope[] {
  const text = (sequence: number, content: string, range: readonly [number, number]): WorkbenchEventEnvelope =>
    envelope(sequence, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: content }] }, { messageId: 'msg' }, { origin: 'local-observed', trust: 'authoritative' }, range)
  return [
    text(4, 't4', [4, 6]),
    text(3, 't1', [1, 3]),
    text(8, 't8', [8, 8]),
    text(7, 't7', [7, 9]),
    envelope(9, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 't1t4t8t7t1t3' }] }, { messageId: 'msg' }, { origin: 'local-observed', trust: 'authoritative' }, [1, 9]),
  ]
}
