import { describe, expect, it } from 'vitest'
import { normalizeRawEvent, type CanonicalNormalizeContext } from '../canonicalNormalizer'
import { projectToolFromCanonical, projectToolFromMessage, toolFieldsFromCanonical } from '../toolProjection'
import type { CanonicalConversationEvent } from '../eventSchema'

const owner = { profileId: 'p1', agentId: 'agent-a', localSessionId: 'local:demo' }

function context(sequence: number, clientGeneration = 3): CanonicalNormalizeContext {
  return { owner, clientGeneration, sequence, receivedAt: '2026-08-14T00:00:00.000Z' }
}

function normalizeToolUpdate(sessionUpdate: string, fields: Record<string, unknown>, sequence: number, clientGeneration = 3): CanonicalConversationEvent {
  return normalizeRawEvent({ update: { sessionUpdate, ...fields } }, context(sequence, clientGeneration)).event
}

describe('projectToolFromCanonical（§5.11 验收 9 字段，字段不丢）', () => {
  it('tool.call.started 投影全字段保留（rawInput 对象 / contentBlocks / owner / generation）', () => {
    const event = normalizeToolUpdate('tool_call', {
      toolCallId: 'tc-1',
      title: 'Read',
      kind: 'read_file',
      rawInput: { path: 'a.txt', mode: 'r' },
      content: [{ type: 'text', text: 'preview' }],
    }, 1, 7)

    const projection = projectToolFromCanonical(event)
    expect(projection).not.toBeUndefined()
    expect(projection).toEqual({
      toolCallId: 'tc-1',
      toolName: 'Read',
      kind: 'read_file',
      rawInput: { path: 'a.txt', mode: 'r' },
      rawOutput: undefined,
      status: undefined,
      contentBlocks: [{ type: 'text', text: 'preview' }],
      owner,
      clientGeneration: 7,
    })
  })

  it('tool.call.completed 投影 rawOutput/status 保留', () => {
    const event = normalizeToolUpdate('tool_call_update', {
      content: { tool_use_id: 'tc-2' },
      rawOutput: { ok: true, lines: 3 },
      status: 'completed',
    }, 2, 9)

    const projection = projectToolFromCanonical(event)
    expect(projection?.toolCallId).toBe('tc-2')
    expect(projection?.rawOutput).toEqual({ ok: true, lines: 3 })
    expect(projection?.status).toBe('completed')
    expect(projection?.owner).toEqual(owner)
    expect(projection?.clientGeneration).toBe(9)
  })

  it('非工具事件（user.message / unknown）→ undefined', () => {
    const user = normalizeToolUpdate('user_message_chunk', { content: { text: 'hi' } }, 3)
    expect(projectToolFromCanonical(user)).toBeUndefined()
    const unknown = normalizeToolUpdate('future_update', { value: 1 }, 4)
    expect(projectToolFromCanonical(unknown)).toBeUndefined()
  })
})

describe('toolFieldsFromCanonical（单一路径提取，normalizer 产出的字段均可识别）', () => {
  it('自 typedPayload.tool 提取 title/kind/rawInput/rawOutput/status/contentBlocks', () => {
    const event = normalizeToolUpdate('tool_call_update', {
      title: 'Write',
      kind: 'write_file',
      rawInput: { path: 'b.txt' },
      rawOutput: 'ok',
      status: 'running',
      content: [{ type: 'text', text: 'w' }],
    }, 5)
    expect(toolFieldsFromCanonical(event)).toEqual({
      title: 'Write',
      kind: 'write_file',
      rawInput: { path: 'b.txt' },
      rawOutput: 'ok',
      status: 'running',
      contentBlocks: [{ type: 'text', text: 'w' }],
    })
  })

  it('空字符串 title/kind 视为缺失（normalizer 纪律）', () => {
    const event = normalizeToolUpdate('tool_call', { toolCallId: 'tc-3', title: '', kind: '' }, 6)
    expect(toolFieldsFromCanonical(event).title).toBeUndefined()
    expect(toolFieldsFromCanonical(event).kind).toBeUndefined()
  })
})

describe('projectToolFromMessage（三路径验收的 Message 级投影）', () => {
  const messageOwner = { profileId: 'profile', agentId: 'peri', localSessionId: 'local:three-path' }

  it('tool Message 全字段投影', () => {
    const projection = projectToolFromMessage({
      externalIdentity: { toolCallId: 'tc-m' },
      toolName: 'Read',
      toolKind: 'read_file',
      rawInput: { path: 'a.txt' },
      rawOutput: { ok: true },
      toolStatus: 'completed',
      contentBlocks: [{ type: 'text', text: 'x' }],
    }, messageOwner, 5)
    expect(projection).toEqual({
      toolCallId: 'tc-m',
      toolName: 'Read',
      kind: 'read_file',
      rawInput: { path: 'a.txt' },
      rawOutput: { ok: true },
      status: 'completed',
      contentBlocks: [{ type: 'text', text: 'x' }],
      owner: messageOwner,
      clientGeneration: 5,
    })
  })

  it('无工具身份的普通消息 → undefined', () => {
    expect(projectToolFromMessage({}, messageOwner, 5)).toBeUndefined()
  })
})
