/**
 * EVT-01 CanonicalConversationEvent schema 纯域单测（方案书 §5.10）。
 *
 * 覆盖：owner key 序列化纪律（JSON 数组禁冒号拼接）/ sequence 按 owner/session 范围分配
 * （隔离、单调、不可变）/ eventId 确定性推导且不依赖 content / 工厂默认值与可选字段 /
 * unknown 事件保留 / 完整性校验正反例。
 */
import { describe, expect, it } from 'vitest'
import {
  allocateEventSequence,
  createCanonicalEvent,
  isUnknownEvent,
  nextEventSequence,
  toCanonicalEventId,
  toCanonicalOwnerKey,
  validateCanonicalEvent,
  type CanonicalEventOwner,
  type CanonicalConversationEvent,
} from '../eventSchema'

const OWNER_A: CanonicalEventOwner = {
  profileId: 'p1',
  agentId: 'peri',
  localSessionId: 'local:同名',
  remoteSessionId: 'remote-1',
}

const OWNER_B: CanonicalEventOwner = {
  profileId: 'p1',
  agentId: 'hermes',
  localSessionId: 'local:同名',
  remoteSessionId: 'remote-2',
}

function event(overrides: Partial<CanonicalConversationEvent> = {}): CanonicalConversationEvent {
  return {
    eventId: '["p1","peri","local:同名"]#1',
    owner: OWNER_A,
    clientGeneration: 5,
    sequence: 1,
    occurredAt: '2026-08-14T00:00:00.000Z',
    receivedAt: '2026-08-14T00:00:00.000Z',
    eventType: 'user.message',
    payloadVersion: 1,
    rawPayload: { text: 'hello' },
    ...overrides,
  }
}

describe('toCanonicalOwnerKey（§5.8/§5.10 序列化纪律）', () => {
  it('JSON 数组序列化，source 含冒号也不歧义；同字段同键', () => {
    expect(toCanonicalOwnerKey(OWNER_A)).toBe('["p1","peri","local:同名"]')
    expect(toCanonicalOwnerKey({ ...OWNER_A })).toBe(toCanonicalOwnerKey(OWNER_A))
  })

  it('双 Agent 同名 source → owner key 隔离', () => {
    expect(toCanonicalOwnerKey(OWNER_A)).not.toBe(toCanonicalOwnerKey(OWNER_B))
  })
})

describe('sequence 分配（§5.10 rule 3：owner/session 范围内分配）', () => {
  it('nextEventSequence：undefined → 1，否则 +1', () => {
    expect(nextEventSequence(undefined)).toBe(1)
    expect(nextEventSequence(5)).toBe(6)
  })

  it('allocateEventSequence 双 Agent 同名 source 各自独立计数', () => {
    const r1 = allocateEventSequence({}, OWNER_A)
    expect(r1.sequence).toBe(1)
    // 同一 owner 继续 → 2（单调递增）
    const r2 = allocateEventSequence(r1.state, OWNER_A)
    expect(r2.sequence).toBe(2)
    // 另一 Agent 同名 source 从 1 起，不与 A 串
    const r3 = allocateEventSequence(r2.state, OWNER_B)
    expect(r3.sequence).toBe(1)
  })

  it('allocateEventSequence 不就地修改传入 state', () => {
    const state = {}
    const { state: next } = allocateEventSequence(state, OWNER_A)
    expect(state).toEqual({})
    expect(next).toEqual({ '["p1","peri","local:同名"]': 1 })
  })
})

describe('eventId（§5.10 rule 1：禁止 content 哈希）', () => {
  it('确定性推导：同 owner+sequence 同 id，不同 sequence 不同 id', () => {
    expect(toCanonicalEventId(OWNER_A, 1)).toBe('["p1","peri","local:同名"]#1')
    expect(toCanonicalEventId(OWNER_A, 1)).toBe(toCanonicalEventId(OWNER_A, 1))
    expect(toCanonicalEventId(OWNER_A, 2)).not.toBe(toCanonicalEventId(OWNER_A, 1))
  })

  it('内容相同仅 sequence 不同 → id 不同（不依赖 content）', () => {
    const a = createCanonicalEvent({ owner: OWNER_A, clientGeneration: 5, sequence: 1, occurredAt: '2026-08-14T00:00:00.000Z', eventType: 'user.message', payloadVersion: 1, rawPayload: { text: 'x' } })
    const b = createCanonicalEvent({ owner: OWNER_A, clientGeneration: 5, sequence: 2, occurredAt: '2026-08-14T00:00:00.000Z', eventType: 'user.message', payloadVersion: 1, rawPayload: { text: 'x' } })
    expect(a.eventId).not.toBe(b.eventId)
  })
})

describe('createCanonicalEvent（工厂）', () => {
  it('receivedAt 缺省取 occurredAt', () => {
    const e = createCanonicalEvent({ owner: OWNER_A, clientGeneration: 5, sequence: 3, occurredAt: '2026-08-14T00:00:00.000Z', eventType: 'user.message', payloadVersion: 1, rawPayload: {} })
    expect(e.receivedAt).toBe(e.occurredAt)
  })

  it('identity 与 typedPayload 存在性落位；rawPayload 恒保留', () => {
    const e = createCanonicalEvent({
      owner: OWNER_A, clientGeneration: 5, sequence: 4, occurredAt: '2026-08-14T00:00:00.000Z', eventType: 'tool.call.started', payloadVersion: 1,
      identity: { toolCallId: 'tc-1', messageId: 'm-1' },
      typedPayload: { name: 'read_file' },
      rawPayload: { raw: true },
    })
    expect(e.identity).toEqual({ toolCallId: 'tc-1', messageId: 'm-1' })
    expect(e.typedPayload).toEqual({ name: 'read_file' })
    expect(e.rawPayload).toEqual({ raw: true })
  })

  it('eventId / toolCallId / messageId 为不同概念，identity 原样保留不被 eventId 改写', () => {
    const e = createCanonicalEvent({
      owner: OWNER_A, clientGeneration: 5, sequence: 7, occurredAt: '2026-08-14T00:00:00.000Z', eventType: 'tool.call.updated', payloadVersion: 1,
      identity: { toolCallId: 'tc-9', messageId: 'msg-9', turnId: 't-9', requestId: 'req-9' },
      rawPayload: {},
    })
    expect(e.identity?.toolCallId).toBe('tc-9')
    expect(e.identity?.messageId).toBe('msg-9')
    expect(e.eventId).not.toBe('tc-9')
    expect(e.eventId).not.toBe('msg-9')
  })
})

describe('unknown 事件（§5.10：不得静默丢弃）', () => {
  it('eventType unknown 合法且 rawPayload 保留', () => {
    const e = createCanonicalEvent({ owner: OWNER_A, clientGeneration: 5, sequence: 8, occurredAt: '2026-08-14T00:00:00.000Z', eventType: 'unknown', payloadVersion: 1, rawPayload: { future: 'thing' } })
    expect(isUnknownEvent(e)).toBe(true)
    expect(validateCanonicalEvent(e)).toEqual([])
    expect(e.rawPayload).toEqual({ future: 'thing' })
  })
})

describe('validateCanonicalEvent（append-only 完整性守卫）', () => {
  it('合法事件 → 无问题', () => {
    expect(validateCanonicalEvent(event())).toEqual([])
    expect(validateCanonicalEvent(event({ eventType: 'unknown' }))).toEqual([])
  })

  it('owner 缺失 / sequence / clientGeneration / eventType / payloadVersion / 时间戳 / eventId 不一致各报错', () => {
    expect(validateCanonicalEvent(event({ owner: { profileId: '', agentId: 'peri', localSessionId: 's' } }))).toContainEqual(expect.stringContaining('owner 必填 profileId/agentId/localSessionId'))
    expect(validateCanonicalEvent(event({ sequence: 0 }))).toContainEqual(expect.stringContaining('sequence 必须为正整数'))
    expect(validateCanonicalEvent(event({ sequence: 1.5 }))).toContainEqual(expect.stringContaining('sequence 必须为正整数'))
    expect(validateCanonicalEvent(event({ clientGeneration: -1 }))).toContainEqual(expect.stringContaining('clientGeneration 必须为非负整数'))
    expect(validateCanonicalEvent(event({ eventType: 'user.x' as never }))).toContainEqual(expect.stringContaining('eventType 不在枚举内'))
    expect(validateCanonicalEvent(event({ payloadVersion: 0 }))).toContainEqual(expect.stringContaining('payloadVersion 必须为正整数'))
    expect(validateCanonicalEvent(event({ occurredAt: 'not-a-date' }))).toContainEqual(expect.stringContaining('occurredAt 非法 ISO'))
    expect(validateCanonicalEvent(event({ receivedAt: 'not-a-date' }))).toContainEqual(expect.stringContaining('receivedAt 非法 ISO'))
    expect(validateCanonicalEvent(event({ eventId: '["p1","peri","local:同名"]#9' }))).toContainEqual(expect.stringContaining('eventId 与 owner+sequence 推导不一致'))
  })

  it('坏形状（event null/非对象/owner 缺失或 null）返回问题项而不抛异常（CR-1）', () => {
    expect(validateCanonicalEvent(null)).toContainEqual(expect.stringContaining('event 必须是对象'))
    expect(validateCanonicalEvent(undefined)).toContainEqual(expect.stringContaining('event 必须是对象'))
    expect(validateCanonicalEvent('raw')).toContainEqual(expect.stringContaining('event 必须是对象'))
    expect(validateCanonicalEvent(event({ owner: undefined as never }))).toContainEqual(expect.stringContaining('owner 必填 profileId/agentId/localSessionId'))
    expect(validateCanonicalEvent(event({ owner: null as never }))).toContainEqual(expect.stringContaining('owner 必填 profileId/agentId/localSessionId'))
    // owner 节点缺失时不得在 eventId 一致性检查二次抛错（entry 守卫短路）
    expect(validateCanonicalEvent(event({ owner: undefined as never })).length).toBeGreaterThanOrEqual(1)
  })
})
