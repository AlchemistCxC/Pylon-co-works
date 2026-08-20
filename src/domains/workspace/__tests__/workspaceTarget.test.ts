import { describe, expect, it } from 'vitest'
import { workspaceTargetFromSession } from '../workspaceTarget.ts'

const base = { id: 's1', agentId: 'a1', source: 'src1', name: 'S', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/legacy', sessionPrompt: '', skills: [], hooks: [], autoName: '' }

describe('workspaceTargetFromSession', () => {
  it('uses workspace binding and does not carry stale legacy workdir', () => {
    expect(workspaceTargetFromSession({ ...base, workspaceId: 'w1' })).toEqual({ sessionId: 's1', agentId: 'a1', source: 'src1', workspaceId: 'w1' })
  })
  it('uses legacy snapshot only for unbound sessions', () => {
    expect(workspaceTargetFromSession(base)).toEqual({ sessionId: 's1', agentId: 'a1', source: 'src1', legacyWorkdir: 'C:/legacy' })
  })
})
