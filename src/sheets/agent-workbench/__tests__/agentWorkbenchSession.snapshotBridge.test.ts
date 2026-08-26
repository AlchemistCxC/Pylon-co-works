import { describe, expect, it } from 'vitest'
import { projectWorkbench } from '../../../domains/workbench/workbenchProjector.ts'
import { messageSnapshotToWorkbenchEnvelopes } from '../agentWorkbenchSession.ts'
import type { Message } from '../../../components/chat/messageTypes.ts'
import { persistMessageSnapshot } from '../../../components/chat/messagePersistence.ts'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import type { Session } from '../../../identityStore.ts'

describe('browser message snapshot bridge', () => {
  it('projects legacy visual messages into the terminal Workbench document', () => {
    const messages: Message[] = [
      { id: 'u-1', role: 'user', sender: 'user', content: '检查渲染', time: '' },
      { id: 't-1', role: 'tool', sender: 'assistant', content: '', time: '', toolName: 'Browser', toolKind: 'browser', toolInput: 'capture', toolOutput: 'PASS', toolStatus: 'completed' },
      { id: 'a-1', role: 'assistant', sender: 'assistant', content: '渲染已恢复。', time: '' },
    ]
    const envelopes = messageSnapshotToWorkbenchEnvelopes('demo', messages)
    const document = projectWorkbench(envelopes).document

    expect(document.messages.map(message => [message.role, message.content])).toEqual([
      ['user', '检查渲染'],
      ['assistant', '渲染已恢复。'],
    ])
    expect(document.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', title: 'Browser', status: 'completed' }),
    ]))
  })

  it('binds the browser Session.id snapshot into the Solid runtime', async () => {
    const session: Session = {
      id: 'demo-visual-matrix', agentId: 'peri', profileId: 'default', source: 'local:demo-visual-matrix',
      name: '渲染状态全景', createdAt: 1, lastActiveAt: 2, platform: 'local', workdir: '/path/to/pylon',
      sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }
    persistMessageSnapshot(session.id, [{ id: 'assistant-1', role: 'assistant', sender: 'assistant', content: 'Solid 已读取 mock', time: '' }], localStorage)
    expect(localStorage.getItem(`pylon-msgs-${session.id}`)).toContain('Solid 已读取 mock')
    const runtime = createAgentWorkbenchSessionRuntime({ subscribe: () => () => {} })
    await runtime.bind(session)
    expect(runtime.runtime.getSnapshot().document?.messages.map(message => message.content)).toEqual(['Solid 已读取 mock'])
    runtime.destroy()
  })

  it('recovers snapshots written under the legacy provider source key', async () => {
    const session: Session = {
      id: 'demo-source-key', agentId: 'peri', profileId: 'default', source: 'local:demo-source-key',
      name: '旧 key', createdAt: 1, lastActiveAt: 2, platform: 'local', workdir: '/tmp',
      sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }
    persistMessageSnapshot(session.source, [{ id: 'legacy-1', role: 'assistant', sender: 'peri', content: 'legacy source key', time: '' }], localStorage)
    const runtime = createAgentWorkbenchSessionRuntime({ subscribe: () => () => {} })
    await runtime.bind(session)
    expect(runtime.runtime.getSnapshot().document?.messages.map(message => message.content)).toEqual(['legacy source key'])
    runtime.destroy()
  })
})
