import { describe, expect, it } from 'vitest'
import { createInteractionResponseTransport } from '../interactionTransport.ts'
import type { InteractionResponseIdentity } from '../../../domains/agent/agentContracts.ts'

const completeIdentity = (overrides: Partial<InteractionResponseIdentity> = {}): InteractionResponseIdentity => ({
  provider: 'peri',
  agentId: 'peri',
  requestId: '7',
  sessionId: 's1',
  toolCallId: 'call-1',
  clientGeneration: 3,
  ...overrides,
})

describe('interaction response transport（P1-5 单一 payload 构造）', () => {
  it('构造唯一 respond_interaction payload 并透传 answer', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
    const transport = createInteractionResponseTransport({
      invoke: async (cmd, args) => { calls.push({ cmd, args }); return undefined },
    })
    await transport.respond(
      { identity: completeIdentity(), kind: 'approval' },
      { optionId: 'allow_once' },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      cmd: 'respond_interaction',
      args: {
        identity: completeIdentity(),
        kind: 'approval',
        answer: { optionId: 'allow_once' },
      },
    })
  })

  it('identity 不完整时拒绝提交且不调用 invoke', async () => {
    let invoked = false
    const transport = createInteractionResponseTransport({
      invoke: async () => { invoked = true; return undefined },
    })
    await expect(
      transport.respond(
        { identity: completeIdentity({ provider: '' }), kind: 'approval' },
        { optionId: 'allow_once' },
      ),
    ).rejects.toThrow(/identity 不完整/)
    await expect(
      transport.respond(
        { identity: completeIdentity({ clientGeneration: null as unknown as number }), kind: 'approval' },
        { optionId: 'allow_once' },
      ),
    ).rejects.toThrow(/identity 不完整/)
    expect(invoked).toBe(false)
  })

  // #356：request-scoped elicitation 的 sessionId 是显式空串——会话外请求以
  // requestId+agentId 收口身份，放行；缺失（undefined）仍拒绝。
  it('request-scoped 身份（显式空 sessionId）放行，缺失仍拒绝', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
    const transport = createInteractionResponseTransport({
      invoke: async (cmd, args) => { calls.push({ cmd, args }); return undefined },
    })
    await transport.respond(
      { identity: completeIdentity({ sessionId: '', toolCallId: undefined }), kind: 'approval' },
      { optionId: 'cancel' },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toMatchObject({ identity: { sessionId: '' } })

    await expect(
      transport.respond(
        { identity: completeIdentity({ sessionId: undefined as unknown as string }), kind: 'approval' },
        { optionId: 'cancel' },
      ),
    ).rejects.toThrow(/identity 不完整/)
    expect(calls).toHaveLength(1)
  })
})
