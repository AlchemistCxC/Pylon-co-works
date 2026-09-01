/**
 * B-03：legacy Message 投影 characterization vectors。
 *
 * 这些 vectors 先锁定 live/replay/restart 共用的语义边界；后续纯规则抽取只能改变
 * adapter 接线，不能改变这里的输入/输出契约。
 */
import { describe, expect, it } from 'vitest'
import { createCanonicalEvent, type CanonicalConversationEvent, type CanonicalEventOwner } from '../eventSchema'
import {
  effectiveCanonicalProjectionEvents,
  projectMessagesFromCanonicalBuiltin,
} from '../messageProjection'

const owner: CanonicalEventOwner = {
  profileId: 'p-b03',
  agentId: 'peri',
  localSessionId: 'local:b03-vectors',
}

type VectorInput = {
  eventType: CanonicalConversationEvent['eventType']
  text?: string
  identity?: CanonicalConversationEvent['identity']
  tool?: Record<string, unknown>
  rawPayload?: unknown
}

type ProjectionExpectation = {
  role: 'user' | 'assistant' | 'tool' | 'reasoning'
  content: string
  id?: string
  running?: boolean
  externalIdentity?: CanonicalConversationEvent['identity']
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolStatus?: string
  toolKind?: string
  rawInput?: unknown
  rawOutput?: unknown
  contentBlocks?: unknown
}

function event(input: VectorInput, sequence: number): CanonicalConversationEvent {
  const typedPayload: Record<string, unknown> = {}
  if (input.text !== undefined) typedPayload.text = input.text
  if (input.tool !== undefined) typedPayload.tool = input.tool
  return createCanonicalEvent({
    owner,
    clientGeneration: 11,
    sequence,
    occurredAt: '2026-09-02T00:00:00.000Z',
    receivedAt: '2026-09-02T00:00:00.000Z',
    eventType: input.eventType,
    payloadVersion: 1,
    identity: input.identity,
    typedPayload: Object.keys(typedPayload).length > 0 ? typedPayload : undefined,
    rawPayload: input.rawPayload ?? {},
  })
}

const vectors: Array<{ name: string; inputs: VectorInput[]; expected: ProjectionExpectation[] }> = [
  {
    name: 'user settles prior running rows and assistant chunks append identity',
    inputs: [
      { eventType: 'assistant.text.delta', text: '先行', identity: { messageId: 'm-before' } },
      { eventType: 'user.message', text: '问题', identity: { messageId: 'u-1', requestId: 'req-1' } },
      { eventType: 'assistant.text.delta', text: '回', identity: { messageId: 'm-1' } },
      { eventType: 'assistant.text.delta', text: '复', identity: { messageId: 'm-1' } },
    ],
    expected: [
      { id: 'msg-1', role: 'assistant', content: '先行', running: false, externalIdentity: { messageId: 'm-before' } },
      { id: 'user-2', role: 'user', content: '问题', running: false, externalIdentity: { messageId: 'u-1' } },
      { id: 'msg-3', role: 'assistant', content: '回复', running: false, externalIdentity: { messageId: 'm-1' } },
    ],
  },
  {
    name: 'thinking chunks append and retain turn identity',
    inputs: [
      { eventType: 'assistant.thinking.delta', text: '思', identity: { turnId: 'turn-1' } },
      { eventType: 'assistant.thinking.delta', text: '考' },
      { eventType: 'assistant.text.delta', text: '答', identity: { messageId: 'answer-1' } },
    ],
    expected: [
      { id: 'thought-1', role: 'reasoning', content: '思考', running: false, externalIdentity: { turnId: 'turn-1' } },
      { id: 'msg-2', role: 'assistant', content: '答', running: false, externalIdentity: { messageId: 'answer-1' } },
    ],
  },
  {
    name: 'tool lifecycle preserves identity, raw fields and terminal status',
    inputs: [
      {
        eventType: 'tool.call.started',
        identity: { toolCallId: 'tool-1' },
        tool: {
          title: 'Read',
          kind: 'read_file',
          rawInput: { path: 'a.txt' },
          contentBlocks: [{ type: 'text', text: 'preview' }],
        },
      },
      {
        eventType: 'tool.call.completed',
        identity: { toolCallId: 'tool-1' },
        tool: { rawOutput: { ok: true }, status: 'completed' },
      },
    ],
    expected: [{
      id: 'tool-tool-1',
      role: 'tool',
      content: '',
      running: false,
      externalIdentity: { toolCallId: 'tool-1' },
      toolName: 'Read',
      toolInput: 'a.txt',
      toolOutput: '{\n  "ok": true\n}',
      toolStatus: 'completed',
      toolKind: 'read_file',
      rawInput: { path: 'a.txt' },
      rawOutput: { ok: true },
      contentBlocks: [{ type: 'text', text: 'preview' }],
    }],
  },
  {
    name: 'tool update before start creates a placeholder then merges start fields',
    inputs: [
      {
        eventType: 'tool.call.failed',
        identity: { toolCallId: 'tool-late' },
        tool: { rawOutput: 'failed early', status: 'failed' },
      },
      {
        eventType: 'tool.call.started',
        identity: { toolCallId: 'tool-late' },
        tool: { title: 'Run', kind: 'execute', rawInput: 'ls' },
      },
    ],
    expected: [{
      id: 'tool-tool-late',
      role: 'tool',
      content: '',
      running: false,
      externalIdentity: { toolCallId: 'tool-late' },
      toolName: 'Run',
      toolInput: 'ls',
      toolOutput: 'failed early',
      toolStatus: 'failed',
      toolKind: 'execute',
      rawInput: 'ls',
      rawOutput: 'failed early',
    }],
  },
  {
    name: 'turn terminal settles every running message',
    inputs: [
      { eventType: 'user.message', text: 'q' },
      { eventType: 'assistant.text.delta', text: 'a' },
      { eventType: 'tool.call.started', identity: { toolCallId: 'tool-running' }, tool: { title: 'Run' } },
      { eventType: 'turn.failed' },
    ],
    expected: [
      { id: 'user-1', role: 'user', content: 'q', running: false },
      { id: 'msg-2', role: 'assistant', content: 'a', running: false },
      { id: 'tool-tool-running', role: 'tool', content: '', running: false, toolStatus: 'completed' },
    ],
  },
  {
    name: 'optimistic user row reconciles with later kernel echo',
    inputs: [
      {
        eventType: 'user.message',
        text: '同一问题',
        rawPayload: { update: { _meta: { pylonOptimisticUser: true, requestId: 'client-1' } } },
      },
      { eventType: 'assistant.text.delta', text: '回答' },
      { eventType: 'user.message', text: '同一问题' },
    ],
    expected: [
      { id: 'user-1', role: 'user', content: '同一问题', running: false },
      { id: 'msg-2', role: 'assistant', content: '回答', running: false },
    ],
  },
]

describe('message projection characterization vectors (B-03)', () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const projected = projectMessagesFromCanonicalBuiltin(vector.inputs.map((input, index) => event(input, index + 1)))
      expect(projected).toHaveLength(vector.expected.length)
      for (const [index, expected] of vector.expected.entries()) {
        expect(projected[index]).toMatchObject(expected)
      }
    })
  }

  it('unknown/malformed canonical rows stay traceable while projection skips them', () => {
    const rawUnknown = { update: { sessionUpdate: 'future_event', payload: { opaque: true } } }
    const events = [
      event({ eventType: 'unknown', rawPayload: rawUnknown }, 1),
      event({ eventType: 'user.message', text: '之后' }, 2),
    ]
    const effective = effectiveCanonicalProjectionEvents(events)
    expect(effective[0]).toMatchObject({ eventType: 'unknown', rawPayload: rawUnknown })
    expect(projectMessagesFromCanonicalBuiltin(events).map(message => message.content)).toEqual(['之后'])
  })
})
