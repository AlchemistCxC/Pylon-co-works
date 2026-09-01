import { describe, expect, it, vi } from 'vitest'
import { applyWorkspaceLayoutChange, type WorkspaceLayoutPorts } from '../applyWorkspaceLayoutChange.ts'

function ports(): WorkspaceLayoutPorts {
  const workspaceState = {
    sidebarWidth: 250, sidebarCollapsed: false, rightPanelCollapsed: false,
    setSidebarWidth: vi.fn(), setSidebarCollapsed: vi.fn(), setRightPanelCollapsed: vi.fn(),
  }
  const railState = {
    width: 320, leftRailWidth: 250, leftRailCollapsed: false, collapsed: false,
    setWidth: vi.fn(), setLeftRailWidth: vi.fn(), setLeftRailCollapsed: vi.fn(), setCollapsed: vi.fn(),
  }
  return { workspace: { getState: () => workspaceState }, rightRail: { getState: () => railState } }
}

describe('applyWorkspaceLayoutChange', () => {
  it('writes both layout projections through one transaction owner', () => {
    const p = ports()
    expect(applyWorkspaceLayoutChange({ sidebarWidth: 300, rightPanelCollapsed: true }, p)).toEqual({ ok: true })
    expect(p.rightRail.getState().setLeftRailWidth).toHaveBeenCalledWith(300)
    expect(p.workspace.getState().setSidebarWidth).toHaveBeenCalledWith(300)
    expect(p.rightRail.getState().setCollapsed).toHaveBeenCalledWith(true)
    expect(p.workspace.getState().setRightPanelCollapsed).toHaveBeenCalledWith(true)
  })

  it('returns a visible failure when a projection write rejects', () => {
    const p = ports()
    p.workspace.getState().setSidebarWidth.mockImplementation(() => { throw new Error('persist failed') })
    const result = applyWorkspaceLayoutChange({ sidebarWidth: 300 }, p)
    expect(result).toEqual({ ok: false, message: 'persist failed' })
  })
})
