/**
 * Tauri 域 typed clients 行为测试（报告阶段 4）：
 * normalize 后出边界、payload 收口、错误上抛。
 */
import { describe, expect, it } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { createWorkspaceClient } from '../workspaceClient'
import { createGatewayClient } from '../gatewayClient'
import { createBrowserClient } from '../browserClient'

describe('workspaceClient', () => {
  it('listEntries 宽容 normalize（损坏项过滤）', async () => {
    const invoke = new FakeInvoke().register('list_workspace_entries', () => [
      { name: 'b.ts', relativePath: '/a/b.ts', kind: 'file' },
      null,
      { name: 'no-kind', relativePath: '/a/x' },
    ])
    const client = createWorkspaceClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const entries = (await client.listEntries('local:一', '/a')) as Array<{ path?: string }>
    expect(entries.some(entry => entry.path === '/a/b.ts')).toBe(true)
  })

  it('gitStatus 发送无参并 normalize', async () => {
    const invoke = new FakeInvoke().register('git_status', () => [
      { path: 'a.ts', status: 'M' },
    ])
    const client = createWorkspaceClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const status = (await client.gitStatus('local:一')) as Array<{ path?: string }>
    expect(status[0]?.path).toBe('a.ts')
    expect(invoke.calls).toEqual([{ cmd: 'git_status', args: { source: 'local:一' } }])
  })
})

describe('gatewayClient', () => {
  it('status normalize 后出边界', async () => {
    const invoke = new FakeInvoke().register('gateway_status', () => ({
      adapters: ['qq'],
      routes: [{ source: 'qq:group:1', agentId: 'peri' }],
      inject: null,
    }))
    const client = createGatewayClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const status = (await client.status()) as { routes?: Array<{ source?: string }> }
    expect(status.routes?.[0]?.source).toBe('qq:group:1')
  })

  it('updateAgentsConfig 原样透传 payload', async () => {
    const invoke = new FakeInvoke().register('update_agents_config', () => null)
    const client = createGatewayClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const payload = { scope: 'gateway', config: { gateway: { routes: [] } } }
    await client.updateAgentsConfig(payload)
    expect(invoke.calls).toEqual([{ cmd: 'update_agents_config', args: payload }])
  })
})

describe('browserClient', () => {
  it('setBounds/close payload 收口', async () => {
    const invoke = new FakeInvoke()
    invoke.register('browser_set_bounds', () => null)
    invoke.register('browser_close', () => null)
    const client = createBrowserClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await client.setBounds({ x: 0, y: 0, width: 100, height: 100 })
    await client.close()
    expect(invoke.calls).toEqual([
      { cmd: 'browser_set_bounds', args: { x: 0, y: 0, width: 100, height: 100 } },
      { cmd: 'browser_close', args: {} },
    ])
  })
})
