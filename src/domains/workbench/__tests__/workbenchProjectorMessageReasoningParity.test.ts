import { describe, expect, it } from 'vitest'
import { projectWorkbench, reduceWorkbenchEvent, selectTimeline, type WorkbenchDocument, type WorkbenchMessage } from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'

// #486 项2 互钉测试：reduceMessage / reduceReasoning 的成对决策（乱序收敛折叠、终态
// 栅栏、K03 乱序丢弃）已收编到 reducer 内共享正身 `foldIntoSealedSegmentOrDrop` /
// `dropOutOfOrderAppend`。本套件钉住两族在这些共享决策上的**同构行为**——绕开共享
// 正身改动任一族，下面的 parity 断言立刻红。
//
// 已知的族间不对称（拆分前即存在，属两族各自的 append 谓词，不在本批收编范围）：
// 封存段后到达「不同 provider 身份」的迟到 delta，message 族按流连续 append 进原段
// （'AB'），reasoning 族因 append 谓词要求 running/同身份终态而开新段（'A','B'）。
// 该差异由「provider 显式边界」用例显式钉住，防止无意识漂移。

const base = {
  provider: 'peri',
  sourceId: 'wire-parity',
  sessionId: 'session-parity',
  recordedAt: '2026-08-21T00:00:00.000Z',
} as const

type Family = 'message' | 'reasoning'

function envelope(
  sequence: number,
  event: WorkbenchSemanticEvent,
  identity: WorkbenchEventEnvelope['identity'] = {},
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    ...base,
    sequence,
    source: { provider: base.provider, sourceId: `${base.sourceId}-${sequence}` },
    identity,
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })
}

function deltaEvent(family: Family, text: string): WorkbenchSemanticEvent {
  return family === 'message'
    ? { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text }] }
    : { type: 'reasoning.delta', parts: [{ kind: 'text', text }] }
}

function terminalEvent(family: Family): WorkbenchSemanticEvent {
  return family === 'message'
    ? { type: 'message.completed', role: 'assistant', parts: [{ kind: 'text', text: '' }] }
    : { type: 'reasoning.completed', parts: [{ kind: 'text', text: '' }] }
}

interface FamilyObservation {
  segments: ReadonlyArray<{ role: string; content: string; running: boolean }>
  timelineTextSequences: readonly number[]
  diagnosticCodes: readonly string[]
}

function observeDocument(family: Family, document: WorkbenchDocument): FamilyObservation {
  return {
    segments: document.messages.map((message: WorkbenchMessage) => ({
      role: message.role,
      content: message.content,
      running: message.running,
    })),
    timelineTextSequences: selectTimeline(document)
      .filter(entry => entry.kind === family)
      .map(entry => entry.sequence),
    diagnosticCodes: document.diagnostics.map(diagnostic => diagnostic.code),
  }
}

/** 批量路径（journal 语义：按 sequence 排序折叠）。 */
function observe(family: Family, envelopes: readonly WorkbenchEventEnvelope[]): FamilyObservation {
  return observeDocument(family, projectWorkbench(envelopes).document)
}

/** 单事件 live 语义：严格按到达顺序逐条归约。 */
function observeSingle(family: Family, envelopes: readonly WorkbenchEventEnvelope[]): FamilyObservation {
  let document = projectWorkbench([]).document
  for (const entry of envelopes) document = reduceWorkbenchEvent(document, entry)
  return observeDocument(family, document)
}

const stripRole = (observed: FamilyObservation) => ({
  segments: observed.segments.map(segment => ({ ...segment, role: 'X' })),
  timelineTextSequences: observed.timelineTextSequences,
  diagnosticCodes: observed.diagnosticCodes,
})

describe('reduceMessage/reduceReasoning 共享决策互钉（#486 项2）', () => {
  it('乱序收敛：journal-earlier delta 折叠入已封存段，两族同构且单事件/批量路径一致', () => {
    for (const family of ['message', 'reasoning'] as const) {
      const ordered = [
        envelope(1, deltaEvent(family, 'A')),
        envelope(2, deltaEvent(family, 'B')),
        envelope(3, terminalEvent(family)),
      ]
      const late = envelope(0, deltaEvent(family, 'C'))
      // 单事件 live 语义：迟到 delta(0) 折入已封存段 → 'ABC'，保持封存，无乱序诊断。
      const singleArrival = observeSingle(family, [...ordered, late])
      expect(singleArrival.segments).toEqual([{ role: singleArrival.segments[0]!.role, content: 'ABC', running: false }])
      expect(singleArrival.diagnosticCodes).not.toContain('out-of-order-text-dropped')
      // 序输入下批量与单事件路径逐字一致（共享正身不得引入路径分叉）。
      expect(observeSingle(family, [late, ...ordered])).toEqual(observe(family, [late, ...ordered]))
    }
    const messageObserved = observeSingle('message', [
      envelope(1, deltaEvent('message', 'A')),
      envelope(2, deltaEvent('message', 'B')),
      envelope(3, terminalEvent('message')),
      envelope(0, deltaEvent('message', 'C')),
    ])
    const reasoningObserved = observeSingle('reasoning', [
      envelope(1, deltaEvent('reasoning', 'A')),
      envelope(2, deltaEvent('reasoning', 'B')),
      envelope(3, terminalEvent('reasoning')),
      envelope(0, deltaEvent('reasoning', 'C')),
    ])
    expect(stripRole(messageObserved)).toEqual(stripRole(reasoningObserved))
  })

  it('终态栅栏：封存回合后的同身份迟到 delta 被丢弃，两族同构', () => {
    for (const family of ['message', 'reasoning'] as const) {
      const observed = observe(family, [
        envelope(1, deltaEvent(family, 'A'), { messageId: 'm1' }),
        envelope(2, terminalEvent(family), { messageId: 'm1' }),
        // 同 messageId、更大 sequence：迟到但无显式 provider 边界 ⇒ 属于已封存回合，丢弃。
        envelope(3, deltaEvent(family, 'X'), { messageId: 'm1' }),
      ])
      expect(observed.segments).toEqual([{ role: observed.segments[0]!.role, content: 'A', running: false }])
      expect(observed.diagnosticCodes).not.toContain('out-of-order-text-dropped')
    }
  })

  it('provider 显式边界：栅栏不丢不同身份的迟到 delta；下游 append 谓词的既有族间差异在此显式钉住', () => {
    const messageObserved = observe('message', [
      envelope(1, deltaEvent('message', 'A'), { messageId: 'm1' }),
      envelope(2, terminalEvent('message'), { messageId: 'm1' }),
      envelope(3, deltaEvent('message', 'B'), { messageId: 'm2' }),
    ])
    const reasoningObserved = observe('reasoning', [
      envelope(1, deltaEvent('reasoning', 'A'), { messageId: 'm1' }),
      envelope(2, terminalEvent('reasoning'), { messageId: 'm1' }),
      envelope(3, deltaEvent('reasoning', 'B'), { messageId: 'm2' }),
    ])
    // 共享栅栏决策的可见结果：m2 delta 未被丢弃（两族的 'B' 都在文档里）。
    expect(messageObserved.segments.map(segment => segment.content).join('')).toContain('B')
    expect(reasoningObserved.segments.map(segment => segment.content).join('')).toContain('B')
    // 下游 append 谓词的既有不对称（见文件头注）：message 追加进封存段，reasoning 开新段。
    expect(messageObserved.segments.map(segment => segment.content)).toEqual(['AB'])
    expect(reasoningObserved.segments.map(segment => segment.content)).toEqual(['A', 'B'])
  })

  it('K03：journal-earlier delta 追在更晚文本之后被丢弃并出示诊断，两族同构', () => {
    for (const family of ['message', 'reasoning'] as const) {
      // 到达顺序：delta(5)'world' 先到（running），随后 journal-earlier delta(3)'hel'——
      // (5,3) 为空区间 ⇒ 流连续判真 ⇒ append 命中乱序位，共享 K03 正身丢弃并出诊断。
      const observed = observeSingle(family, [
        envelope(5, deltaEvent(family, 'world')),
        envelope(3, deltaEvent(family, 'hel')),
      ])
      expect(observed.segments).toEqual([{ role: observed.segments[0]!.role, content: 'world', running: true }])
      expect(observed.diagnosticCodes).toContain('out-of-order-text-dropped')
    }
  })
})
