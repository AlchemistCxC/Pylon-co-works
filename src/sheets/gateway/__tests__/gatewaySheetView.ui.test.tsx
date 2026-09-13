// @vitest-environment jsdom
/**
 * P79 Gateway 页交互优化行为回归：
 * 1. 凭据表单按 catalog credentialFields 动态渲染（QQ = App ID + Client Secret 两框），
 *    提交按字段顺序 join ':' 写入 gateway_instance_set_credentials；
 * 2. 删除二段确认：第一次点击不触发删除（仅进入确认态），二次点击才调用命令；
 * 3. 实例状态轮询：sheet 挂载期间每 3s 重新拉取 gateway_instances（状态翻转可见性）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { FakeInvoke } from '../../../test/fakeInvoke'
import GatewaySheetView from '../GatewaySheetView'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import { clearErrors } from '../../../errorCenter.ts'

const fakeInvoke = new FakeInvoke()

const CATALOG = [
  {
    platform: 'qq',
    label: 'QQ',
    availability: 'builtIn',
    credentialFields: [
      { key: 'appId', label: 'App ID', secret: false, required: true },
      { key: 'clientSecret', label: 'Client Secret', secret: true, required: true },
    ],
    capabilities: { deliverText: true, deliverEvent: true, ingest: true, maxMessageLen: 4000 },
  },
]

function installHandlers(instances: Array<Record<string, unknown>>): void {
  fakeInvoke.registerMany({
    gateway_status: () => ({ adapters: [], routes: [], inject: null }),
    gateway_sessions: () => [],
    gateway_instances: () => instances,
    gateway_catalog: () => CATALOG,
  })
}

function renderSheet(): void {
  const sheet: SheetRecord = { id: 'gw', kind: 'gateway', title: 'Gateway', createdAt: 0, lastFocusedAt: 0 }
  render(<GatewaySheetView sheet={sheet} ctx={{} as SheetContext} />)
}

function flushEffects(): Promise<unknown> {
  return act(async () => {})
}

describe('P79 Gateway 页交互优化', () => {
  beforeEach(() => {
    fakeInvoke.calls.length = 0
    const w = window as unknown as Record<string, unknown>
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => fakeInvoke.invoke(cmd, args ?? {}),
      transformCallback: () => 0,
      unregisterCallback: () => {},
      convertFileSrc: (path: string) => path,
    }
  })

  afterEach(() => {
    clearErrors()
    vi.useRealTimers()
  })

  it('凭据表单按 catalog 渲染双字段，提交按字段顺序 join ":"', async () => {
    installHandlers([
      { id: 'qq-acc', platform: 'qq', label: 'QQ', enabled: true, autoStart: false, status: 'stopped', lastError: null, credentialStatus: 'missing', credentialRef: null },
    ])
    renderSheet()
    await flushEffects()

    // 双字段渲染：App ID 明文框 + Client Secret 密码框（aria-label 带 instance id）
    const appId = screen.getByLabelText('qq-acc App ID') as HTMLInputElement
    const clientSecret = screen.getByLabelText('qq-acc Client Secret') as HTMLInputElement
    expect(appId).toBeDefined()
    expect(clientSecret.type).toBe('password')

    // 必填字段未填齐 → 保存凭据禁用
    expect((screen.getByRole('button', { name: '保存凭据' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(appId, { target: { value: 'app123' } })
    fireEvent.change(clientSecret, { target: { value: 'secretXYZ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }))
    await flushEffects()

    const call = fakeInvoke.calls.find(entry => entry.cmd === 'gateway_instance_set_credentials')
    expect(call).toBeDefined()
    expect(call!.args).toEqual({ id: 'qq-acc', secret: 'app123:secretXYZ' })
  })

  it('删除需要二次确认：首次点击不删，确认后才调用命令', async () => {
    installHandlers([
      { id: 'qq-del', platform: 'qq', label: 'QQ', enabled: true, autoStart: false, status: 'stopped', lastError: null, credentialStatus: 'configured', credentialRef: 'r1' },
    ])
    renderSheet()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: '删除 qq-del' }))
    await flushEffects()
    expect(fakeInvoke.calls.some(entry => entry.cmd === 'gateway_instance_remove')).toBe(false)
    expect(screen.getByRole('button', { name: '确认删除 qq-del' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '确认删除 qq-del' }))
    await flushEffects()
    const call = fakeInvoke.calls.find(entry => entry.cmd === 'gateway_instance_remove')
    expect(call).toBeDefined()
    expect(call!.args).toEqual({ id: 'qq-del' })
  })

  it('实例状态轮询：挂载期间定时重拉 gateway_instances', async () => {
    vi.useFakeTimers()
    installHandlers([
      { id: 'qq-acc', platform: 'qq', label: 'QQ', enabled: true, autoStart: false, status: 'starting', lastError: null, credentialStatus: 'configured', credentialRef: 'r1' },
    ])
    renderSheet()
    await flushEffects()
    const instancesCallsBefore = fakeInvoke.calls.filter(entry => entry.cmd === 'gateway_instances').length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    const instancesCallsAfter = fakeInvoke.calls.filter(entry => entry.cmd === 'gateway_instances').length
    expect(instancesCallsAfter).toBeGreaterThan(instancesCallsBefore)
  })
})
