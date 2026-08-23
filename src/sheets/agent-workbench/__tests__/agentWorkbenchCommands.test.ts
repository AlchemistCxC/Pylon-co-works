import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../../../identityStore.ts'
import { createAgentWorkbenchCommandFacade } from '../agentWorkbenchCommands.ts'
import type { InteractionResponseIdentity } from '../../../domains/agent/agentContracts.ts'

const session: Session = {
  id: 'session-a', source: 'local:a', agentId: 'peri', profileId: 'profile-a', name: 'A',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: 'session rules',
  skills: [], hooks: [], autoName: '',
}

describe('Agent Workbench production commands', () => {
  it('send 以本地 Session 解析 durable owner，并在 ACP 调用前写入 optimistic user', async () => {
    const optimistic = vi.fn()
    const sendMessage = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      resolvePersona: () => 'profile persona',
      sendMessage,
      optimisticUser: optimistic,
      nextClientMessageId: () => 'client-1',
    })

    await expect(commands.send('session-a', {
      text: 'hello',
      attachments: [{ id: 'a', path: 'G:/note.md' }],
    })).resolves.toEqual({ status: 'sent', messageId: 'client-1' })
    expect(optimistic).toHaveBeenCalledWith('local:a', 'hello', 'client-1')
    expect(sendMessage).toHaveBeenCalledWith({
      agentId: 'peri', profileId: 'profile-a', source: 'local:a', content: 'hello',
      persona: 'profile persona', sessionPrompt: 'profile persona\n\nsession rules', attachments: ['G:/note.md'],
    })
    expect(optimistic.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0])
  })

  it('model/mode 命令只通过 Session owner 对应的既有 ACP seam', async () => {
    const setModel = vi.fn(async () => undefined)
    const setMode = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      setModel,
      setMode,
    })

    await expect(commands.setModel(session.id, 'model-a')).resolves.toEqual({ ok: true })
    await expect(commands.setMode(session.id, 'plan')).resolves.toEqual({ ok: true })
    expect(setModel).toHaveBeenCalledWith({ agentId: 'peri', source: 'local:a' }, 'model-a')
    expect(setMode).toHaveBeenCalledWith({ agentId: 'peri', source: 'local:a' }, 'plan')
  })

  it('interaction command 从同一 document 解析完整事务 identity，再走统一 response transport', async () => {
    const identity: InteractionResponseIdentity = {
      provider: 'peri', agentId: 'peri', requestId: 'request-a', sessionId: 'local:a', clientGeneration: 7,
    }
    const respondInteraction = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      resolveInteraction: (sessionId, interactionId) => sessionId === session.id && interactionId === 'interaction-a'
        ? { identity, kind: 'approval' }
        : undefined,
      respondInteraction,
    })

    await expect(commands.respondInteraction(session.id, 'interaction-a', { optionId: 'allow_once' })).resolves.toEqual({ ok: true })
    expect(respondInteraction).toHaveBeenCalledWith({ identity, kind: 'approval' }, { optionId: 'allow_once' })
    await expect(commands.respondInteraction(session.id, 'missing', { optionId: 'allow_once' }))
      .resolves.toEqual({ ok: false, error: 'interaction_not_found' })
  })

  it('在 transport 前拒绝与当前 canonical interaction 不一致的 stale revision', async () => {
    const identity: InteractionResponseIdentity = {
      provider: 'peri', agentId: 'peri', requestId: 'request-a', sessionId: 'local:a', clientGeneration: 7,
    }
    const respondInteraction = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      resolveInteraction: () => ({ identity, kind: 'approval', revision: 12 }),
      respondInteraction,
    })

    await expect(commands.respondInteraction(session.id, 'interaction-a', { optionId: 'allow_once' }, { expectedRevision: 11 }))
      .resolves.toEqual({ ok: false, error: 'interaction_revision_stale' })
    expect(respondInteraction).not.toHaveBeenCalled()
  })
})
