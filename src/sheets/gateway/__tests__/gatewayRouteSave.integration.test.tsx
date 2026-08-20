// @vitest-environment jsdom
/**
 * FE-AUD-004 行为回归（阶段 0，先 RED）+ I12 W6（LR2-WI02）UI consumer。
 *
 * 目标行为：
 * 1. 「新增路由」保存 payload 的 routes 必须包含 gateway_status 回读的既有 routes + 新路由（合并）；
 * 2. 保存成功后重新读取 gateway_status 校验（不以 invoke resolve 为成功）；
 * 3. I12 W6：新增路由表单必须可选择 instance/profile/session，保存携带全字段（yaml 键写回）；
 * 4. 严格校验：缺 instance/profile/session 时禁止保存并显示错误；
 * 5. 旧 route 迁移：平台唯一 enabled instance 时既有 legacy route 自动补绑定 instanceId。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { useIdentityStore } from '../../../identityStore'
import GatewaySheetView from '../GatewaySheetView'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

const fakeInvoke = new FakeInvoke()

/** 安装 Tauri internals，让 @tauri-apps/api/core 的真实 invoke 走 fakeInvoke（集成路径） */
function installFakeTauriInternals(): void {
  const w = window as unknown as Record<string, unknown>
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => fakeInvoke.invoke(cmd, args ?? {}),
    transformCallback: () => 0,
    unregisterCallback: () => {},
    convertFileSrc: (path: string) => path,
  }
}

const EXISTING_ROUTES = [
  { source: 'qq:group:1', agentId: 'peri', profileId: 'profile-a', sessionKey: '', reset: 'idle', idleMinutes: 30, allowFrom: [] },
  { source: 'qq:group:2', agentId: 'profile-b', profileId: 'profile-a', sessionKey: '', reset: 'idle', idleMinutes: 30, allowFrom: [] },
]

const INSTANCES = [
  { id: 'qq-bot-1', platform: 'qq', label: 'QQ Bot 1', enabled: true, autoStart: false, status: 'stopped', lastError: null, credentialStatus: 'configured', credentialRef: 'r1' },
]

function installHandlers(): void {
  fakeInvoke.registerMany({
    gateway_status: () => ({ adapters: ['qq'], routes: EXISTING_ROUTES, inject: { enabled: true, scenario: 'prelude', persist: 'true' } }),
    gateway_sessions: () => [],
    gateway_instances: () => INSTANCES,
    gateway_catalog: () => [{ platform: 'qq', label: 'QQ', availability: 'builtIn', credentialFields: [], capabilities: { deliverText: true, deliverEvent: false, ingest: true, maxMessageLen: 4000 } }],
    agent_config_snapshot: () => ({ revision: 'gateway-rev-1', agents: [], diagnostics: [] }),
    update_agents_config: () => ({ revision: 'gateway-rev-2' }),
    reload_gateway: () => null,
  })
}

function renderGateway(): void {
  const sheet: SheetRecord = { id: 'gw', kind: 'gateway', title: 'Gateway', createdAt: 0, lastFocusedAt: 0 }
  render(<GatewaySheetView sheet={sheet} ctx={{} as SheetContext} />)
}

async function fillAndSave(source: string, agentId: string): Promise<void> {
  renderGateway()
  await screen.findByText(/qq:group:1/)
  fireEvent.change(screen.getByLabelText('路由 source'), { target: { value: source } })
  fireEvent.change(screen.getByLabelText('路由 agentId'), { target: { value: agentId } })
  fireEvent.change(screen.getByLabelText('路由 instance'), { target: { value: 'qq-bot-1' } })
  fireEvent.change(screen.getByLabelText('路由 profile'), { target: { value: 'profile-a' } })
  fireEvent.change(screen.getByLabelText('路由 session'), { target: { value: '战役1' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
}

describe('FE-AUD-004 Gateway 安全写回', () => {
  beforeEach(() => {
    fakeInvoke.calls.length = 0
    installFakeTauriInternals()
    installHandlers()
    // 表单 profile 下拉读取 identityStore.profiles——注入 fixture profile 使路由可选
    useIdentityStore.setState({ profiles: [{ id: 'profile-a', name: 'Profile A', persona: 'p', model: 'm' }, { id: 'profile-b', name: 'Profile B', persona: 'p', model: 'm' }] })
  })

  it('保存新路由时 payload 合并既有 routes（当前只发新路由 → RED）', async () => {
    await fillAndSave('qq:group:3', 'peri')
    await waitFor(() => {
      const call = fakeInvoke.calls.find(call => call.cmd === 'update_agents_config')
      expect(call).toBeDefined()
      const routes = (call!.args as { config: { gateway: { routes: Array<{ source: string }> } } }).config.gateway.routes
      expect(routes.map(route => route.source).sort()).toEqual(['qq:group:1', 'qq:group:2', 'qq:group:3'])
    })
  })

  it('保存成功后重新读取 gateway_status 校验（当前不重读 → RED）', async () => {
    await fillAndSave('qq:group:3', 'peri')
    await waitFor(() => {
      expect(fakeInvoke.calls.some(call => call.cmd === 'update_agents_config')).toBe(true)
    })
    const statusCalls = fakeInvoke.calls.filter(call => call.cmd === 'gateway_status')
    expect(statusCalls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('I12 W6 UI consumer（LR2-WI02）', () => {
  beforeEach(() => {
    fakeInvoke.calls.length = 0
    installFakeTauriInternals()
    installHandlers()
    useIdentityStore.setState({ profiles: [{ id: 'profile-a', name: 'Profile A', persona: 'p', model: 'm' }, { id: 'profile-b', name: 'Profile B', persona: 'p', model: 'm' }] })
  })

  it('表单提供 instance/profile/session 选择（缺失 → RED）', async () => {
    renderGateway()
    await screen.findByText(/qq:group:1/)
    expect(screen.getByLabelText('路由 instance')).toBeDefined()
    expect(screen.getByLabelText('路由 profile')).toBeDefined()
    expect(screen.getByLabelText('路由 session')).toBeDefined()
  })

  it('严格校验：缺 instance 保存 → 显示错误且不调 update_agents_config', async () => {
    renderGateway()
    await screen.findByText(/qq:group:1/)
    fireEvent.change(screen.getByLabelText('路由 source'), { target: { value: 'qq:group:9' } })
    fireEvent.change(screen.getByLabelText('路由 agentId'), { target: { value: 'peri' } })
    // 不选 instance/profile，不填 session
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })
    expect(fakeInvoke.calls.some(call => call.cmd === 'update_agents_config')).toBe(false)
  })

  it('完整表单保存 → payload 携带 yaml 键 instance/profile/session（写回契约）', async () => {
    await fillAndSave('qq:group:3', 'peri')
    await waitFor(() => {
      const call = fakeInvoke.calls.find(call => call.cmd === 'update_agents_config')
      expect(call).toBeDefined()
    })
    const call = fakeInvoke.calls.find(call => call.cmd === 'update_agents_config')!
    const routes = (call.args as { config: { gateway: { routes: Array<Record<string, unknown>> } } }).config.gateway.routes
    const newRoute = routes.find(route => route.source === 'qq:group:3')
    expect(newRoute).toBeDefined()
    expect(newRoute!.agent).toBe('peri')
    expect(newRoute!.instance).toBe('qq-bot-1')
    expect(newRoute!.profile).toBe('profile-a')
    expect(newRoute!.session).toBe('战役1')
    expect(JSON.stringify(call.args)).not.toMatch(/agentId|profileId|sessionKey|instanceId/)
  })

  it('旧 route 迁移：平台唯一 enabled instance → 既有 legacy route 保存时自动补绑定 instance', async () => {
    await fillAndSave('qq:group:3', 'peri')
    await waitFor(() => {
      const call = fakeInvoke.calls.find(call => call.cmd === 'update_agents_config')
      expect(call).toBeDefined()
    })
    const call = fakeInvoke.calls.find(call => call.cmd === 'update_agents_config')!
    const routes = (call.args as { config: { gateway: { routes: Array<Record<string, unknown>> } } }).config.gateway.routes
    const legacy = routes.find(route => route.source === 'qq:group:1')
    expect(legacy).toBeDefined()
    expect(legacy!.instance).toBe('qq-bot-1')
  })

  it('route 详情展示 instanceId 绑定（Unbound 显示—）', async () => {
    renderGateway()
    await screen.findByText(/qq:group:1/)
    fireEvent.click(screen.getByText(/qq:group:1/))
    await screen.findByText(/instanceId/)
  })
})
