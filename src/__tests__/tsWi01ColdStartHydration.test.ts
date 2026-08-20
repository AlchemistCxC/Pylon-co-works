/**
 * TS-WI01 RED：冷启动必须先恢复 workspace owner hints，再迁移 v1 sessions。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { hydrateIdentityAndWorkspace } from '../app/bootstrap/hydrateIdentityAndWorkspace'
import { useIdentityStore } from '../identityStore'
import { SESSION_STORAGE_KEY } from '../sessionPersistence'
import { resetStores } from '../test/resetStores'
import { useWorkspaceStore } from '../workspaceStore'

const legacySession = {
  id: 'legacy-session', name: 'Legacy', source: 'local:legacy-session', profileId: 'profile-a',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
}

function seed(): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ version: 1, sessions: [legacySession] }))
  localStorage.setItem('pylon-workspace-sheets', JSON.stringify({
    version: 2,
    state: {
      sheets: [{ id: 'agent-peri', kind: 'agent', agentId: 'peri', title: 'Peri', createdAt: 1, lastFocusedAt: 1 }],
      activeSheetId: 'agent-peri', recentlyClosed: [],
      agentStates: { peri: { activeSessionId: legacySession.id, activeProfileId: 'profile-a' } },
    },
    layout: { sidebarWidth: 250, sidebarCollapsed: false, rightPanelCollapsed: false },
  }))
}

describe('TS-WI01 冷启动 owner hint 顺序', () => {
  beforeEach(() => { localStorage.clear(); resetStores(); seed() })

  it('RED：统一 hydration coordinator 应先 workspace 再 sessions', async () => {
    await hydrateIdentityAndWorkspace()
    expect(useIdentityStore.getState().sessions).toEqual([
      expect.objectContaining({ id: legacySession.id, agentId: 'peri' }),
    ])
    expect(useIdentityStore.getState().sessionHydration).toEqual({ kind: 'ready' })
    expect(useWorkspaceStore.getState().sheetAgentStates.peri?.activeSessionId).toBe(legacySession.id)
  })
})
