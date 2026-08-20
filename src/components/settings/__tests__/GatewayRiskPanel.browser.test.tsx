/**
 * ISSUE-13 W5 GatewayRiskPanel browser 模式（无后端，IS_TAURI=false）：
 * 提示需要 Tauri 后端，不调 invoke。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import GatewayRiskPanel from '../GatewayRiskPanel'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

describe('GatewayRiskPanel browser 模式', () => {
  beforeEach(() => { invokeMock.mockReset() })

  it('提示需要 Tauri 后端，不调 invoke', () => {
    render(<GatewayRiskPanel />)
    expect(screen.getByText(/Gateway 管理需要 Tauri 后端/)).toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
