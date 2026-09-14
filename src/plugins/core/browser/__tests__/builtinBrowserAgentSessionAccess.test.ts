import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore } from '../../../../identityStore.ts'
import { resetStores } from '../../../../test/resetStores.ts'
import { BROWSER_AGENT_MCP_ID } from '../builtinBrowserAgentSessionAccess.ts'
import { runSessionPreflight } from '../../sessionCreation/sessionPreflight.ts'

const invokeMock = vi.mocked(invoke)

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('builtin browser agent session access（issue #82）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invokeMock.mockReset()
  })

  async function createSessionAndPreflight() {
    const sessionId = useIdentityStore.getState().addSession('浏览器会话')
    const created = useIdentityStore.getState().sessions.find(session => session.id === sessionId)
    expect(created).toBeDefined()
    return runSessionPreflight(created!)
  }

  it('readonly 档位：注入 pylon-browser MCP server，--session 携带会话身份', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'browser_agent_resolve_access') return { mode: 'readonly' }
      if (command === 'browser_agent_exe_path') return { path: 'G:/pylon/pylon.exe' }
      throw new Error(`unexpected command ${command}`)
    })
    const preflight = await createSessionAndPreflight()
    expect(preflight.mcpServers).toHaveLength(1)
    const server = preflight.mcpServers[0] as { id: string; transport: string; command: string; args: string[] }
    expect(server.id).toBe(BROWSER_AGENT_MCP_ID)
    expect(server.transport).toBe('stdio')
    expect(server.command).toBe('G:/pylon/pylon.exe')
    expect(server.args[0]).toBe('browser-bridge')
    expect(server.args[1]).toBe('--session')
    expect(server.args[2]).toBeTruthy()
    expect(preflight.diagnostics).toEqual([])
  })

  it('off 档位：不产出任何 mcpServers', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'browser_agent_resolve_access') return { mode: 'off' }
      throw new Error(`unexpected command ${command}`)
    })
    const preflight = await createSessionAndPreflight()
    expect(preflight.mcpServers).toEqual([])
  })

  it('Rust 未就绪（invoke 失败）：静默跳过注入且不产生 diagnostic（fail-closed）', async () => {
    invokeMock.mockRejectedValue(new Error('command not found'))
    const preflight = await createSessionAndPreflight()
    expect(preflight.mcpServers).toEqual([])
    expect(preflight.diagnostics).toEqual([])
  })
})
