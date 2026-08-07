// @vitest-environment jsdom
/**
 * FE-AUD-004 行为回归（阶段 0，先 RED）：Gateway「新增路由」不得覆盖既有 routes。
 *
 * 目标行为：保存 payload 的 routes 必须包含 gateway_status 回读的既有 routes +
 * 新路由（合并）；保存成功后重新读取 gateway_status 校验（不以 invoke resolve 为成功）。
 * 当前实现（2026-08-07）只发送 [{ source, agentId }] 且保存后不重读 → 本文件应 RED。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FakeInvoke } from '../../../test/fakeInvoke'
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
  { source: 'qq:group:1', agentId: 'peri', profileId: 'riccati', sessionKey: '', reset: 'session', idleMinutes: 30, allowFrom: [] },
  { source: 'qq:group:2', agentId: 'serina', profileId: 'riccati', sessionKey: '', reset: 'session', idleMinutes: 30, allowFrom: [] },
]

function installHandlers(): void {
  fakeInvoke.registerMany({
    gateway_status: () => ({ adapters: ['qq'], routes: EXISTING_ROUTES, inject: { enabled: true, scenario: 'prelude', persist: 'true' } }),
    gateway_sessions: () => [],
    update_agents_config: () => null,
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
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
}

describe('FE-AUD-004 Gateway 安全写回', () => {
  beforeEach(() => {
    fakeInvoke.calls.length = 0
    installFakeTauriInternals()
    installHandlers()
  })

  it('保存新路由时 payload 合并既有 routes（当前只发新路由 → RED）', async () => {
    await fillAndSave('qq:group:3', 'peri')
    await waitFor(() => {
      const call = fakeInvoke.calls.find(call => call.cmd === 'update_agents_config')
      expect(call).toBeDefined()
      const routes = (call!.args as { config: { gateway: { routes: Array<{ source: string; agentId: string }> } } }).config.gateway.routes
      expect(routes.map(route => route.source).sort()).toEqual(['qq:group:1', 'qq:group:2', 'qq:group:3'])
    })
  })

  it('保存成功后重新读取 gateway_status 校验（当前不重读 → RED）', async () => {
    await fillAndSave('qq:group:3', 'peri')
    await waitFor(() => {
      expect(fakeInvoke.calls.some(call => call.cmd === 'update_agents_config')).toBe(true)
    })
    // 目标行为：保存成功后至少回读一次 gateway_status 验证最终 routes
    const statusCalls = fakeInvoke.calls.filter(call => call.cmd === 'gateway_status')
    expect(statusCalls.length).toBeGreaterThanOrEqual(2)
  })
})
