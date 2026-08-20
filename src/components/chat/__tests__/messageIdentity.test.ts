import { describe, expect, it } from 'vitest'
import { detectChatIdentityCapabilities, extractExternalIdentity, reconcileIngressMessages } from '../messageIdentity'

type M = { id: string; role: string; content: string; externalIdentity?: Record<string, string> }

const message = (id: string, content: string, externalIdentity?: Record<string, string>): M => ({ id, role: 'assistant', content, externalIdentity })

describe('通用 ACP message identity', () => {
  it('根据真实 replay payload 动态识别 capability，不猜测缺失字段', () => {
    expect(detectChatIdentityCapabilities([
      { update: { sessionUpdate: 'agent_message_chunk', content: { messageId: 'msg-A', text: 'x' } } },
      { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1' } },
    ])).toEqual({ message: 'supported', event: 'unsupported', turn: 'unsupported', toolCall: 'supported' })
    expect(detectChatIdentityCapabilities([{ update: { sessionUpdate: 'agent_message_chunk', content: { text: 'same' } } }])).toEqual({
      message: 'unsupported', event: 'unsupported', turn: 'unsupported', toolCall: 'unsupported',
    })
  })

  it('只有明确 supported 的 capability 才参与 reconciliation', () => {
    const resolved = [message('replay-1', '相同', { messageId: 'm-1' })]
    const live = [message('live-1', '相同', { messageId: 'm-1' })]
    expect(reconcileIngressMessages(resolved, live, { message: 'supported' })).toHaveLength(1)
    expect(reconcileIngressMessages(resolved, live, { message: 'unknown' })).toHaveLength(2)
    expect(reconcileIngressMessages(resolved, live, { message: 'unsupported' })).toHaveLength(2)
  })

  it('没有 identity 时相同正文全部保留', () => {
    const resolved = [message('replay-1', '相同')]
    const live = [message('live-1', '相同')]
    expect(reconcileIngressMessages(resolved, live)).toHaveLength(2)
  })

  it('不从正文、sender 或本地 id 推断 identity', () => {
    expect(extractExternalIdentity({ id: 'm-1', content: '相同', sender: 'peri' }, { message: 'supported' })).toBeUndefined()
  })

  it('tool 只有明确 toolCallId 且 capability supported 才合并', () => {
    const resolved = [{ ...message('tool-a', '输出'), role: 'tool', externalIdentity: { toolCallId: 'tc-1' } }]
    const live = [{ ...message('tool-b', '输出'), role: 'tool', externalIdentity: { toolCallId: 'tc-1' } }]
    expect(reconcileIngressMessages(resolved, live, { toolCall: 'supported' })).toHaveLength(1)
    expect(reconcileIngressMessages(resolved, live, { toolCall: 'unknown' })).toHaveLength(2)
  })
})
