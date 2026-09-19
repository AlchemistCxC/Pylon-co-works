/**
 * #205：批量重放投影的线性化等价性 + 规模护栏。
 *
 * 背景（生产实测）：切会话冷读把「未被 turn.unit 覆盖的 delta 行」全量下发，而
 * `projectWorkbench` 批量路径每事件重建 timeline 数组、覆盖区间数组与 activities id 集，
 * 并按整条 timeline 做 tool/文本边界查询 ⇒ Θ(N²)：40,000 行 49.5s、20,000 行 7.5–8.1s
 * （每翻倍 ×4.0）。线性化后同一输入 40,000 行 1.1s（每翻倍 ×1.9）。
 *
 * 本文件钉死两件事：
 * 1. **语义等价**：批量路径（就地追加/就地并入/索引查询）与单事件路径
 *    （`reduceWorkbenchEvent`，逐事件复制）对同一输入产出同一个文档；
 * 2. **不退化回二次**：大规模输入的耗时上界（护栏，非性能基准）。
 */
import { describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  projectWorkbench,
  reduceWorkbenchEvent,
  type WorkbenchDocument,
} from '../../domains/workbench/workbenchProjector.ts'
import {
  createWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
  type WorkbenchSemanticEvent,
} from '../../domains/workbench/events/workbenchEventSchema.ts'

const SESSION = 'session-205'

function envelope(
  sequence: number,
  event: WorkbenchSemanticEvent,
  options: { coverage?: readonly [number, number]; messageId?: string; toolCallId?: string } = {},
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId: SESSION,
    sequence,
    recordedAt: `2026-09-20T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    source: { provider: 'peri', sourceId: `p205-${sequence}` },
    identity: {
      ...(options.messageId ? { messageId: options.messageId } : {}),
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
    ...(options.coverage ? { coverage: options.coverage } : {}),
  })
}

const userMessage = (text: string): WorkbenchSemanticEvent => ({ type: 'message.delta', role: 'user', parts: [{ kind: 'text', text }] })
const textDelta = (text: string): WorkbenchSemanticEvent => ({ type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text }] })
const reasoningDelta = (text: string): WorkbenchSemanticEvent => ({ type: 'reasoning.delta', parts: [{ kind: 'text', text }] })

/** 逐事件路径（改造前的语义基准：每事件整数组复制 + 整条 timeline 扫描）。 */
function reducePerEvent(events: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(SESSION))
}

/** 只比较文档的语义面（冻结包装与对象身份不属于契约）。 */
function shapeOf(document: WorkbenchDocument): unknown {
  return JSON.parse(JSON.stringify({
    revision: document.revision,
    appliedRanges: document.appliedRanges,
    appliedEventIds: document.appliedEventIds,
    messages: document.messages,
    activities: document.activities,
    interactions: document.interactions,
    timeline: document.timeline.map(entry => ({ id: entry.id, sequence: entry.sequence, kind: entry.kind, status: entry.status })),
    session: document.session,
    diagnostics: document.diagnostics,
    plan: document.plan,
    goal: document.goal,
    lifecycle: document.lifecycle,
  }))
}

/** 覆盖 [2,5]/[6,9]/[8,12]（相邻吸收 + 重叠合并）与 [28,32]/[30,31]（乱序到达的包含关系）。 */
function mixedStream(): WorkbenchEventEnvelope[] {
  return [
    envelope(1, userMessage('问题')),
    envelope(2, reasoningDelta('思'), { coverage: [2, 5], messageId: 'thought-1' }),
    envelope(6, reasoningDelta('考'), { coverage: [6, 9], messageId: 'thought-1' }),
    envelope(8, reasoningDelta('重叠段'), { coverage: [8, 12], messageId: 'thought-1' }),
    envelope(13, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, { toolCallId: 'tool-1' }),
    envelope(14, { type: 'tool.completed', tool: { toolCallId: 'tool-1', name: 'read', status: 'completed' } }, { toolCallId: 'tool-1' }),
    envelope(15, textDelta('答')),
    envelope(20, { type: 'usage.updated', usage: { contextUsed: 100, contextLimit: 1000 } }),
    envelope(28, reasoningDelta('后半段'), { coverage: [28, 32], messageId: 'thought-1' }),
    envelope(30, reasoningDelta('乱序到达'), { coverage: [30, 31], messageId: 'thought-1' }),
    envelope(33, { type: 'session.commands-updated', commands: [{ name: 'help', description: '帮助' }] }),
    envelope(34, { type: 'reasoning.completed', parts: [], reason: 'done' }, { messageId: 'thought-1' }),
  ]
}

describe('#205 批量投影线性化', () => {
  it('批量路径与逐事件路径产出同一文档（含相邻/重叠覆盖区间与 tool 边界）', () => {
    const events = mixedStream()
    const batch = projectWorkbench(events).document
    const perEvent = reducePerEvent(events)

    expect(shapeOf(batch)).toEqual(shapeOf(perEvent))
    expect(batch.appliedRanges).toEqual(perEvent.appliedRanges)
    expect(batch.appliedRanges).toEqual([[2, 12], [28, 32]])
  })

  it('乱序输入与升序输入等价（入口排序后语义不变）', () => {
    const events = mixedStream()
    const ascending = projectWorkbench([...events].reverse()).document
    const sorted = projectWorkbench(events).document

    expect(shapeOf(ascending)).toEqual(shapeOf(sorted))
  })

  it('已应用的初始文档上折入增量：与逐事件路径一致', () => {
    const events = mixedStream()
    const initial = projectWorkbench(events.slice(0, 7)).document
    const delta = events.slice(7)

    const batch = projectWorkbench(delta, { initialDocument: initial }).document
    const perEvent = delta.reduce(reduceWorkbenchEvent, initial)

    expect(shapeOf(batch)).toEqual(shapeOf(perEvent))
  })

  it('重复事件幂等：同一输入投影两次结果稳定', () => {
    const events = mixedStream()
    const once = projectWorkbench(events).document
    const twice = projectWorkbench([...events, ...events]).document

    expect(shapeOf(twice)).toEqual(shapeOf(once))
  })

  it('规模护栏：20,000 条 delta 的投影必须是线性量级（Θ(N²) 会超时）', () => {
    const total = 20_000
    const events: WorkbenchEventEnvelope[] = [
      envelope(1, userMessage('长思考')),
      ...Array.from({ length: total }, (_, index) =>
        envelope(index + 2, reasoningDelta(`第${index}段`), { coverage: [index + 2, index + 2], messageId: 'thought-perf' })),
    ]

    const started = performance.now()
    const document = projectWorkbench(events).document
    const elapsed = performance.now() - started

    // 线性化后实测 ~0.2s（本环境；Bun 直跑 ~0.6s）；改造前同级输入 8s+（每翻倍 ×4）。
    // 上界取 2.5s：留 ~10× 余量吸收 CI 抖动，同时对二次退化（改造前 8s+）仍然报警。
    expect(elapsed).toBeLessThan(2_500)
    expect(document.timeline.length).toBe(total + 1)
    const thoughts = document.messages.filter(message => message.role === 'reasoning')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]!.content.length).toBeGreaterThan(total)
  })
})
