/**
 * #81 L2：appliedRanges 覆盖判断（裁决指定的最大风险点——先测试后换读路径）。
 *
 * - journal 信封（携带 coverage）以区间覆盖做幂等并合并且升序；
 * - 非 journal 信封（optimistic/session-response，无 coverage）保持 eventId 幂等；
 * - 「live 逐 chunk 覆盖 + 单元 segment 到达」互斥（不重复投影）；
 * - 同一 compact 行集的任意分批投影 ⇒ 文档逐字节相等（重放 == 增量）。
 */
import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent } from '../../../domains/workbench/workbenchProjector.ts'

function deltaEnvelope(options: {
  sequence: number
  text: string
  role?: 'assistant' | 'user'
  coverage?: readonly [number, number]
  eventId?: string
}): WorkbenchEventEnvelope {
  const role = options.role ?? 'assistant'
  return createWorkbenchEnvelope({
    sessionId: 'session-ranges',
    sequence: options.sequence,
    recordedAt: '2026-09-15T00:00:00.000Z',
    eventId: options.eventId,
    source: { provider: 'peri', sourceId: `s-${options.sequence}` },
    identity: { messageId: 'msg-1' },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    ...(options.coverage ? { coverage: options.coverage } : {}),
    event: { type: 'message.delta', role, parts: [{ kind: 'text', text: options.text }] },
  })
}

describe('workbenchProjector appliedRanges（#81 L2）', () => {
  it('coverage 信封按区间幂等：同一跨度投影两次不重复', () => {
    const envelope = deltaEnvelope({ sequence: 6, text: 'abc', coverage: [1, 6] })
    const document = reduceWorkbenchEvent(createWorkbenchDocument('session-ranges'), envelope)
    const twice = reduceWorkbenchEvent(document, envelope)
    expect(twice).toBe(document)
    expect(document.appliedRanges).toEqual([[1, 6]])
    expect(document.messages).toHaveLength(1)
    expect(document.messages[0].content).toBe('abc')
  })

  it('区间升序合并且不重叠；不相邻区间保持独立', () => {
    let document = createWorkbenchDocument('session-ranges')
    for (const coverage of [[4, 6], [1, 3], [8, 8], [7, 9]] as const) {
      document = reduceWorkbenchEvent(document, deltaEnvelope({
        sequence: coverage[1], text: `t${coverage[0]}`, coverage: [...coverage],
      }))
    }
    expect(document.appliedRanges).toEqual([[1, 9]])
  })

  it('live 逐 chunk 覆盖后单元 segment 到达：coverage 互斥，不重复拼接', () => {
    let document = createWorkbenchDocument('session-ranges')
    for (const sequence of [1, 2, 3, 4, 5, 6]) {
      document = reduceWorkbenchEvent(document, deltaEnvelope({ sequence, text: `${sequence}`, coverage: [sequence, sequence] }))
    }
    expect(document.messages[0].content).toBe('123456')
    // 单元 segment（整段 [1..6]，text 为拼接结果）经 live 到达 → 已覆盖 → 跳过
    const documentAfterUnit = reduceWorkbenchEvent(document, deltaEnvelope({
      sequence: 6, text: '123456', coverage: [1, 6],
    }))
    expect(documentAfterUnit).toBe(document)
  })

  it('非 journal 信封（无 coverage）保持 eventId 幂等并记入 appliedEventIds', () => {
    const document = createWorkbenchDocument('session-ranges')
    const optimistic = deltaEnvelope({ sequence: 7, text: 'opt', eventId: 'optimistic:x' })
    expect(optimistic.eventId).toBe('optimistic:x')
    const once = reduceWorkbenchEvent(document, optimistic)
    expect(once.appliedEventIds).toContain('optimistic:x')
    expect(once.appliedRanges).toEqual([])
    const twice = reduceWorkbenchEvent(once, optimistic)
    expect(twice).toBe(once)
  })

  it('重放 == 增量：同一 compact 行集任意分批投影，文档逐字节相等', () => {
    // compact 读 = 1 个单元 segment（覆盖 [1..6]）+ 未覆盖行 seq 7（tool 语义此处用文本替代）
    const unitEnvelope = deltaEnvelope({ sequence: 6, text: '你好世界', coverage: [1, 6] })
    const uncovered = deltaEnvelope({ sequence: 7, text: '!' })
    const all = [unitEnvelope, uncovered]
    const replay = projectWorkbench(all, { initialDocument: createWorkbenchDocument('session-ranges') }).document
    const incrementalFirst = projectWorkbench([unitEnvelope], { initialDocument: createWorkbenchDocument('session-ranges') }).document
    const incremental = projectWorkbench([uncovered], { initialDocument: incrementalFirst }).document
    expect(JSON.stringify(incremental)).toBe(JSON.stringify(replay))
  })

  it('部分覆盖的 segment 不再重放已覆盖部分：文档内容与逐 chunk 投影一致', () => {
    // 逐 chunk 投影（journal 为 batch/单行时的粒度）
    let chunked = createWorkbenchDocument('session-ranges')
    const texts = ['你', '好', '世', '界']
    texts.forEach((text, index) => {
      const sequence = index + 1
      chunked = reduceWorkbenchEvent(chunked, deltaEnvelope({ sequence, text, coverage: [sequence, sequence] }))
    })
    // 单元 segment 整段替换投影（compact 读路径）
    const segmented = reduceWorkbenchEvent(createWorkbenchDocument('session-ranges'), deltaEnvelope({
      sequence: 4, text: '你好世界', coverage: [1, 4],
    }))
    expect(segmented.messages[0].content).toBe(chunked.messages[0].content)
    expect(segmented.appliedRanges).toEqual(chunked.appliedRanges)
  })
})
