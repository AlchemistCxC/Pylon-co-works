// @vitest-environment jsdom
/**
 * CWD-03 冻结语义：applyWorkspaceRootChange 只更新 Workspace rootPath；
 * 不 close、不 reload、不改绑定会话 workdir（会话 cwd 创建后不变）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: invokeMock }

const { applyWorkspaceRootChange } = await import('../applyWorkspaceRootChange')
const { useIdentityStore } = await import('../../../identityStore')
const { useWorkspaceEntityStore } = await import('../../../workspaceEntityStore')
const { useRuntimeStore } = await import('../../../runtimeStore')
const { toAgentContextKey } = await import('../../../agentContext')

const CONTEXT = { agentId: 'peri', source: 'local:s1' }
const RELOAD_KEY = toAgentContextKey(CONTEXT)
const NEW_ROOT = 'C:/new/root'

const session = {
  id: 's1',
  agentId: 'peri',
  name: 'S1',
  source: 'local:s1',
  periId: 'peri-1',
  profileId: 'p',
  createdAt: 1,
  lastActiveAt: 1,
  platform: 'local',
  workdir: 'C:/old/root',
  workspaceId: 'ws-1',
  sessionPrompt: '',
  skills: [],
  hooks: [],
  autoName: '',
}

const workspace = {
  id: 'ws-1',
  agentId: 'peri',
  name: 'WS-A',
  rootPath: 'C:/old/root',
  createdAt: 1,
  lastActiveAt: 1,
  skills: [],
  mcpServerIds: [],
  hookPluginIds: [],
}

const workspaceUpdateShape = { ...workspace, rootPath: NEW_ROOT, lastActiveAt: 2 }

function seedStores() {
  useRuntimeStore.getState().resetSessionRuntime()
  useIdentityStore.setState({ sessions: [session] })
  useWorkspaceEntityStore.setState({ workspaces: [workspace], hydrated: true })
}

beforeEach(() => {
  invokeMock.mockReset()
  seedStores()
})

describe('applyWorkspaceRootChange 冻结语义', () => {
  it('只更新 workspace rootPath；绑定会话 workdir 不变、不触发 reload', async () => {
    invokeMock.mockImplementation(() => Promise.resolve(workspaceUpdateShape))

    const result = await applyWorkspaceRootChange('ws-1', NEW_ROOT)

    expect(result).toEqual({ ok: true })
    expect(useWorkspaceEntityStore.getState().workspaces[0].rootPath).toBe(NEW_ROOT)
    expect(useIdentityStore.getState().sessions[0].workdir).toBe('C:/old/root')
    expect(useRuntimeStore.getState().sessionReloadTokens[RELOAD_KEY]).toBeUndefined()
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('workspace_update', expect.objectContaining({ workspaceId: 'ws-1', rootPath: NEW_ROOT }))
    expect(invokeMock).not.toHaveBeenCalledWith('close_session', expect.anything())
  })

  it('workspace 更新失败 → 返回 error，不改任何状态', async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error('update failed')))

    const result = await applyWorkspaceRootChange('ws-1', NEW_ROOT)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('error')
    expect(result.message).toBe('update failed')
    expect(useIdentityStore.getState().sessions[0].workdir).toBe('C:/old/root')
    expect(useRuntimeStore.getState().sessionReloadTokens[RELOAD_KEY]).toBeUndefined()
  })
})
