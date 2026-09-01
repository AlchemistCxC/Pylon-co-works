// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeWorkspaces, type Workspace } from '../workspaceEntities.ts'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../infrastructure/tauri/env', () => ({ IS_TAURI: true, isBrowserMockRuntime: () => false }))

import { useWorkspaceEntityStore } from '../workspaceEntityStore.ts'

const legacy: Workspace = {
  id: 'legacy-workspace-id',
  agentId: 'peri',
  name: 'Legacy',
  rootPath: 'C:\\legacy',
  createdAt: 1,
  lastActiveAt: 2,
  skills: ['review'],
  mcpServerIds: [],
  hookPluginIds: [],
}

describe('Workspace 后端持久化升级迁移', () => {
  beforeEach(() => {
    localStorage.clear()
    invoke.mockReset()
    useWorkspaceEntityStore.setState({ workspaces: [], hydrated: false })
  })

  it('后端首次为空时保留 id 导入旧前端镜像', async () => {
    localStorage.setItem('pylon-workspaces', serializeWorkspaces([legacy]))
    invoke.mockImplementation(async (command: string) => {
      if (command === 'workspace_list') return []
      if (command === 'workspace_restore') return [legacy]
      throw new Error(`unexpected command: ${command}`)
    })

    await useWorkspaceEntityStore.getState().hydrate()

    expect(invoke).toHaveBeenNthCalledWith(1, 'workspace_list')
    expect(invoke).toHaveBeenNthCalledWith(2, 'workspace_restore', { workspaces: [legacy] })
    expect(useWorkspaceEntityStore.getState().workspaces).toEqual([legacy])
  })
})
