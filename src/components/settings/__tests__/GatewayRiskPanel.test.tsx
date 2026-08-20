/**
 * ISSUE-13 W5 GatewayRiskPanel 测试：
 * - Tauri 模式：加载实例 → 显示实例/凭据状态 + 备份边界提示（不伪装备份加密）
 * - 空实例 / 加载失败可重试 / browser 模式提示需后端
 * - T13-7：Gateway secret 不进入通用导出（CONFIG_STORAGE_KEYS 无凭据 key）
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import GatewayRiskPanel from '../GatewayRiskPanel'
import { CONFIG_STORAGE_KEYS } from '../../../configExportImport'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
vi.mock('../../../infrastructure/tauri/env', () => ({ IS_TAURI: true }))

const instances = [
  { id: 'qq-main', platform: 'qq', label: '主 QQ', enabled: true, autoStart: false,
    status: 'connected', lastError: null, credentialStatus: 'configured', credentialRef: 'ref' },
  { id: 'qq-spare', platform: 'qq', label: '备用', enabled: false, autoStart: false,
    status: 'stopped', lastError: null, credentialStatus: 'missing', credentialRef: null },
]

describe('GatewayRiskPanel Tauri 模式', () => {
  beforeEach(() => {
    localStorage.clear()
    invokeMock.mockReset()
  })

  it('加载实例 → 显示状态与凭据状态 + 备份边界提示（不伪装备份加密）', async () => {
    invokeMock.mockResolvedValueOnce(instances)
    render(<GatewayRiskPanel />)
    expect(await screen.findByText(/实例 2 个：已配置凭据 1、\s*未配置 1/)).toBeInTheDocument()
    expect(screen.getByText(/主 QQ · 已连接 · 凭据：已配置/)).toBeInTheDocument()
    expect(screen.getByText(/备用 · 已停止 · 凭据：未配置/)).toBeInTheDocument()
    // 未配置凭据的实例 → 无法连接提示
    expect(screen.getByText(/有实例未配置凭据，无法连接/)).toBeInTheDocument()
    // 备份边界：准确提示，不假定已加密备份
    expect(screen.getByText(/安全备份能力尚未提供/)).toBeInTheDocument()
    expect(screen.getByText(/不进入通用设置导出/)).toBeInTheDocument()
    expect(screen.getByText(/请勿假定已存在加密备份/)).toBeInTheDocument()
    expect(invokeMock.mock.calls[0][0]).toBe('gateway_instances')
  })

  it('空实例 → 提示尚未创建', async () => {
    invokeMock.mockResolvedValueOnce([])
    render(<GatewayRiskPanel />)
    expect(await screen.findByText(/尚未创建 Gateway 实例/)).toBeInTheDocument()
  })

  it('加载中显示骨架文案', () => {
    let resolve!: (value: unknown) => void
    invokeMock.mockReturnValueOnce(new Promise(r => { resolve = r }))
    render(<GatewayRiskPanel />)
    expect(screen.getByText(/正在加载 Gateway 实例…/)).toBeInTheDocument()
    resolve(instances)
  })

  it('损坏凭据实例与 lastError 展示（CR-002）', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'qq-broken', platform: 'qq', label: '损坏实例', enabled: true, autoStart: false,
        status: 'error', lastError: '凭据解密失败', credentialStatus: 'invalid', credentialRef: null },
      ...instances,
    ])
    render(<GatewayRiskPanel />)
    expect(await screen.findByText(/损坏实例 · 错误 · 凭据解密失败 · 凭据：损坏/)).toBeInTheDocument()
    expect(screen.getByText(/实例 3 个：已配置凭据 1、\s*未配置 1、\s*损坏 1/)).toBeInTheDocument()
  })

  it('加载失败 → 错误 + 重试成功', async () => {
    invokeMock
      .mockRejectedValueOnce({ code: 'gateway_error', message: 'catalog 不可用' })
      .mockResolvedValueOnce(instances)
    render(<GatewayRiskPanel />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('读取 Gateway 实例失败')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(screen.getByText(/实例 2 个/)).toBeInTheDocument()
    })
  })
})

describe('T13-7：Gateway secret 不进入通用导出', () => {
  it('CONFIG_STORAGE_KEYS 不含任何 gateway/凭据 key', () => {
    const joined = CONFIG_STORAGE_KEYS.join(' ')
    expect(joined).not.toMatch(/gateway/i)
    expect(joined).not.toMatch(/credential/i)
    expect(joined).not.toMatch(/secret/i)
    expect(joined).not.toMatch(/instance/i)
  })
})
