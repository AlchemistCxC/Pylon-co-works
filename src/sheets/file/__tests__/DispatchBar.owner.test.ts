import { describe, expect, it } from 'vitest'
import { resolveDispatchOwnerSession } from '../DispatchBar.tsx'
import type { Session } from '../../../identityStore.ts'

const session = (id: string, agentId: string): Session => ({
  id, agentId, name: id, source: 'workspace-a', profileId: 'profile-a', createdAt: 1, lastActiveAt: 1,
  platform: 'local', workdir: 'C:/workspace', sessionPrompt: '', skills: [], hooks: [], autoName: id,
})

describe('DispatchBar owner resolution', () => {
  it('uses the bound target session when a source has multiple sessions', () => {
    const first = session('session-1', 'agent-a')
    const second = session('session-2', 'agent-a')
    expect(resolveDispatchOwnerSession([first, second], 'workspace-a', { agentId: 'agent-a', source: 'workspace-a' }, 'session-2')).toBe(second)
  })

  it('keeps ambiguous legacy source-only dispatch blocked', () => {
    const first = session('session-1', 'agent-a')
    const second = session('session-2', 'agent-a')
    expect(resolveDispatchOwnerSession([first, second], 'workspace-a', { agentId: 'agent-a', source: 'workspace-a' })).toBeUndefined()
  })
})

