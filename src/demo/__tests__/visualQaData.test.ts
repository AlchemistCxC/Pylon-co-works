import { describe, expect, it } from 'vitest'
import {
  buildVisualQaMessages,
  buildVisualQaPluginPackages,
  buildVisualQaSessions,
  buildVisualQaWorkspaces,
} from '../visualQaData.ts'
import { mockInvokeCommand } from '../mockTauri.ts'

describe('browser visual QA dataset', () => {
  it('provides a dense, referentially valid workspace/session graph', () => {
    const sessions = buildVisualQaSessions()
    const workspaces = buildVisualQaWorkspaces()
    const workspaceIds = new Set(workspaces.map(workspace => workspace.id))

    expect(sessions.length).toBeGreaterThanOrEqual(10)
    expect(workspaces.length).toBeGreaterThanOrEqual(8)
    expect(new Set(sessions.map(session => session.id)).size).toBe(sessions.length)
    expect(new Set(workspaces.map(workspace => workspace.id)).size).toBe(workspaces.length)
    expect(sessions.filter(session => session.workspaceId).every(session => workspaceIds.has(session.workspaceId!))).toBe(true)
    expect(sessions.some(session => session.workspaceId === undefined)).toBe(true)
    expect(workspaces.some(workspace => workspace.rootPath.length > 70)).toBe(true)
  })

  it('covers rich renderers, long context, tool states, i18n and empty state', () => {
    const matrix = buildVisualQaMessages('demo-visual-matrix')
    const longContext = buildVisualQaMessages('demo-long-context')
    const swarm = buildVisualQaMessages('demo-task-swarm')
    const i18n = buildVisualQaMessages('demo-i18n')

    expect(matrix.length).toBeGreaterThanOrEqual(20)
    expect(longContext).toHaveLength(36)
    expect(swarm.filter(message => message.role === 'tool').length).toBeGreaterThanOrEqual(20)
    const toolStates = new Set(swarm.map(message => message.toolStatus).filter(Boolean))
    expect(toolStates.size).toBe(7)
    expect([...toolStates]).toEqual(expect.arrayContaining(['completed', 'in_progress', 'waiting', 'failed']))
    expect(i18n.map(message => message.content).join('\n')).toMatch(/日本語/)
    expect(i18n.map(message => message.content).join('\n')).toMatch(/العربية/)
    expect(buildVisualQaMessages('demo-empty')).toEqual([])
  })

  it('populates browser backend workspaces and API 1.0 plugin packages', async () => {
    const workspaces = await mockInvokeCommand('workspace_list')
    const packages = buildVisualQaPluginPackages()
    const installed = await mockInvokeCommand('plugin_package_list')

    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'w-pylon', skills: expect.any(Array) }),
    ]))
    expect(installed).toHaveLength(packages.length)
    expect(packages.every(item => item.package.manifest.api === '1.0' && item.enabled === false)).toBe(true)
  })

  it('keeps browser-mode Git mutations stateful for interaction QA', async () => {
    await mockInvokeCommand('git_stage', { paths: ['src/sheets/AgentSheetView.tsx'] })
    const staged = await mockInvokeCommand('git_status_with_branch') as { entries: Array<{ path: string; staged: boolean }> }
    expect(staged.entries.find(entry => entry.path === 'src/sheets/AgentSheetView.tsx')?.staged).toBe(true)

    const branch = await mockInvokeCommand('git_create_branch', { name: 'feature/visual-qa' }) as { status: { branch: { branch: string } } }
    expect(branch.status.branch.branch).toBe('feature/visual-qa')

    await mockInvokeCommand('git_unstage', { paths: ['src/sheets/AgentSheetView.tsx'] })
  })
})
