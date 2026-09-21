// #220 WP2 切流：投影核过界通道（帧编码 / 页级合批 / 边界穿越读数 / 结构共享）。
//
// 折叠语义的正确性由 workbench 域的行为测试与 projectorComputeParity 门禁兜底；
// 本文件钉的是**边界纪律**：
// - 批量入口是唯一形态：一页一帧，边界穿越次数与页内事件数无关；
// - 物化层结构共享：patch 判定未变化的切片沿用引用，幂等折叠恒等返回原文档
//   （#205/P57 契约，runtime memo 链依赖引用稳定）；
// - appliedEventIds/appliedRanges 冻结（公开契约）。

import { describe, expect, it } from 'vitest'

import {
  createProjector,
  createSessionProjector,
  encodeProjectorFrame,
  foldIntoProjector,
  projectWorkbenchFold,
  readProjectorBoundaryCrossings,
  reduceWorkbenchFold,
  resetProjectorBoundaryCrossings,
  type ProjectorState,
} from '../projectorCompute.ts'
import { createWorkbenchEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { createWorkbenchDocument, projectWorkbench } from '../../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'

const SESSION = 'session-compute'

function envelope(
  sequence: number,
  event: Record<string, unknown>,
  options: { coverage?: readonly [number, number]; messageId?: string } = {},
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId: SESSION,
    sequence,
    recordedAt: '2026-09-21T00:00:00.000Z',
    source: { provider: 'peri', sourceId: `pc-${sequence}` },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    ...(options.messageId ? { identity: { messageId: options.messageId } } : {}),
    ...(options.coverage ? { coverage: options.coverage } : {}),
    event: event as never,
  })
}

const textDelta = (sequence: number, text: string, messageId = 'm-1'): WorkbenchEventEnvelope =>
  envelope(sequence, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text }] }, { messageId })

describe('帧编码与批量入口', () => {
  it('PYPB v2 帧头：magic/版本/事件数/池长，词表外类型拒绝', () => {
    const frame = encodeProjectorFrame([textDelta(1, 'hello')])
    const view = new DataView(frame.buffer)
    expect(Array.from(frame.slice(0, 4))).toEqual([0x50, 0x59, 0x50, 0x42])
    expect(view.getUint16(4, true)).toBe(2)
    expect(view.getUint32(6, true)).toBe(1)
    expect(() => encodeProjectorFrame([
      envelope(1, { type: 'no.such.type' }),
    ])).toThrow(/不在投影词表内/)
  })

  it('冷装载一页 N 事件：固定 2 次边界穿越（帧进 + 文档出），与页大小无关', () => {
    resetProjectorBoundaryCrossings()
    const page = [
      textDelta(1, 'a'),
      textDelta(2, 'b'),
      envelope(3, { type: 'tool.started', tool: { toolCallId: 't-1', name: 'read' } }),
      envelope(4, { type: 'session.completed', stopReason: 'end_turn' }),
    ]
    const { document } = projectWorkbenchFold(page)
    expect(document.messages.map(message => message.content)).toEqual(['ab'])
    expect(document.session.status).toBe('completed')
    // 4 事件一帧过界：appendBatch(1) + document(1)。
    expect(readProjectorBoundaryCrossings()).toBe(2)
  })

  it('1000 事件冷装载页：仍是 2 次穿越（按页合批的读数证据）', () => {
    resetProjectorBoundaryCrossings()
    const page = Array.from({ length: 1000 }, (_, index) => textDelta(index + 1, `第${index}段`, 'thought'))
    const state: ProjectorState = { projector: createProjector(SESSION) }
    const { document } = foldIntoProjector(state, page)
    expect(document.messages).toHaveLength(1)
    expect(document.messages[0]!.content).toContain('第999段')
    expect(readProjectorBoundaryCrossings()).toBe(2)
  })
})

describe('物化层结构共享（#205/P57 契约）', () => {
  it('幂等折叠（重复 eventId）恒等返回同一文档对象', () => {
    const state: ProjectorState = { projector: createProjector(SESSION) }
    const event = textDelta(1, 'hello')
    const first = foldIntoProjector(state, [event]).document
    const twice = foldIntoProjector(state, [event]).document
    expect(twice).toBe(first)
    expect(first.appliedEventIds).toEqual([event.eventId])
  })

  it('coverage 已覆盖区间重放：整文档恒等返回', () => {
    const state: ProjectorState = { projector: createProjector(SESSION) }
    const first = foldIntoProjector(state, [envelope(2, { type: 'reasoning.delta', parts: [{ kind: 'text', text: '思' }] }, { coverage: [2, 5], messageId: 'r-1' })]).document
    const replayed = foldIntoProjector(state, [envelope(4, { type: 'reasoning.delta', parts: [{ kind: 'text', text: '乱序' }] }, { coverage: [4, 4], messageId: 'r-1' })]).document
    expect(replayed).toBe(first)
    expect(first.appliedRanges).toEqual([[2, 5]])
  })

  it('未触碰切片沿用引用；appliedEventIds/appliedRanges 冻结', () => {
    const state: ProjectorState = { projector: createProjector(SESSION) }
    const first = foldIntoProjector(state, [
      envelope(1, { type: 'tool.started', tool: { toolCallId: 't-1', name: 'read' } }),
    ]).document
    const second = foldIntoProjector(state, [textDelta(2, '正文')]).document
    // usage/文本 delta 不触碰 activities：引用沿用（runtime memo 链依赖）。
    expect(second.activities).toBe(first.activities)
    expect(second.appliedEventIds).not.toBe(first.appliedEventIds)
    expect(Object.isFrozen(second.appliedEventIds)).toBe(true)
    expect(Object.isFrozen(second.appliedRanges)).toBe(true)
    expect(Object.isFrozen(second.appliedRanges[0])).toBe(true)
  })
})

describe('池化纯函数折叠（document-in/out 兼容层）', () => {
  it('链式折叠复用同一投影核：与整页折叠收敛到同一文档', () => {
    resetProjectorBoundaryCrossings()
    const events = [
      textDelta(1, '你'),
      textDelta(2, '好'),
      envelope(3, { type: 'tool.started', tool: { toolCallId: 't-9', name: 'grep' } }),
    ]
    const batched = projectWorkbench(events).document
    let chained = createWorkbenchDocument(SESSION)
    for (const event of events) chained = reduceWorkbenchFold(chained, event)
    expect(chained.messages.map(message => message.content)).toEqual(batched.messages.map(message => message.content))
    expect(chained.appliedEventIds).toEqual(batched.appliedEventIds)
    expect(chained.activities.map(activity => activity.id)).toEqual(batched.activities.map(activity => activity.id))
    // 穿越口径（#220 ③-b 之后）：热路径不再每次折叠都读全量文档。
    // - 冷启动 / 外置文档：`appendBatch` + `document()` = 2 次（下面是「整页折叠」与
    //   「链式首次以手工构造的文档为 base」两种情况，都属外置 ⇒ 各 2 次）；
    // - 上一份文档就是本核产出时：只走 `appendBatch` = 1 次（链式折入的后两次）。
    expect(readProjectorBoundaryCrossings()).toBe(1 * 2 + 1 * 2 + 2 * 1)
  })

  it('会话句柄与池化折叠同源：同一页产出同一文档', () => {
    const page = [textDelta(1, '同'), envelope(2, { type: 'session.status-updated', status: 'running' })]
    const pooled = projectWorkbench(page, { initialDocument: createWorkbenchDocument(SESSION) }).document
    const sessionFolded = createSessionProjector(SESSION).fold(page)
    expect(sessionFolded.messages).toEqual(pooled.messages)
    expect(sessionFolded.session.status).toBe(pooled.session.status)
  })
})

describe('MessagePatch 紧凑追加形态（live 逐事件热路径）', () => {
  const started = envelope(1, { type: 'message.started', role: 'assistant', parts: [{ kind: 'text', text: '头' }] }, { messageId: 'm-1' })

  it('逐事件 delta 折叠下发 append 形态，且与整页折叠收敛到同一文档', () => {
    const deltas = Array.from({ length: 8 }, (_, index) => textDelta(index + 2, `第${index}段`))
    // 逐事件：每拍一帧（生产 live 的调用形态）。
    const state: ProjectorState = { projector: createProjector(SESSION) }
    const patches = [foldIntoProjector(state, [started]).patch]
    for (const delta of deltas) patches.push(foldIntoProjector(state, [delta]).patch)
    // 对照：同一批事件整页折一次。
    const whole = foldIntoProjector({ projector: createProjector(SESSION) }, [started, ...deltas]).document
    expect(state.lastDocument?.messages.map(message => message.content)).toEqual(whole.messages.map(message => message.content))
    // 新消息（批内追加区）走全量；其后每拍 delta 走紧凑形态。
    expect(patches[0]!.messageUpserts[0]).toHaveProperty('message')
    for (const [index, patch] of patches.slice(1).entries()) {
      const upsert = patch.messageUpserts[0]!
      expect(upsert.message).toBeUndefined()
      expect(upsert.append).toBeDefined()
      expect(upsert.append!.contentTail).toBe(`第${index}段`)
      expect(upsert.append!.sequence).toBeDefined()
      // running 自 started 起就是 true 且未变：指纹判据不下发未漂移的标量（省字节的正确行为）。
      expect(upsert.append!.running).toBeUndefined()
    }
  })

  it('textTail 携带 kind 覆写：text→markdown 翻转与文本追加同时生效', () => {
    const state: ProjectorState = { projector: createProjector(SESSION) }
    foldIntoProjector(state, [started])
    foldIntoProjector(state, [textDelta(2, '正文')])
    const patch = foldIntoProjector(state, [envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'markdown', text: '# 标题' }] }, { messageId: 'm-1' })]).patch
    const lastPart = patch.messageUpserts[0]!.append!.lastPart!
    expect(lastPart.mode).toBe('textTail')
    if (lastPart.mode === 'textTail') {
      expect(lastPart.tail).toBe('# 标题')
      expect(lastPart.kind).toBe('markdown')
    }
    expect(state.lastDocument?.messages[0]?.parts[0]).toMatchObject({ kind: 'markdown', text: '头正文# 标题' })
  })

  it('不合族部件走 pushedParts，紧凑应用与全量形态等值', () => {
    const events = [
      started,
      textDelta(2, '正文'),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'code', text: 'let x = 1' }] }, { messageId: 'm-1' }),
      textDelta(4, '结尾'),
    ]
    const state: ProjectorState = { projector: createProjector(SESSION) }
    for (const event of events) foldIntoProjector(state, [event])
    const pushedPatch = foldIntoProjector({ projector: createProjector(SESSION) }, [events[2]!]).patch
    // 单事件核没有批前消息 → 全量形态（这里只关心值本身）；等值锚定靠下面的整页对照。
    expect(pushedPatch.messageUpserts[0]).toBeDefined()
    const whole = foldIntoProjector({ projector: createProjector(SESSION) }, events).document
    expect(state.lastDocument?.messages[0]?.parts).toEqual(whole.messages[0]?.parts)
    expect(state.lastDocument?.messages[0]?.content).toBe(whole.messages[0]?.content)
  })
})
