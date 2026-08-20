// @vitest-environment jsdom
/**
 * I13 修复回归测试（React #185）：带会话挂载 ControlCenter（含 widget 链
 * InputBar/ModelWidget/useSessionLiveStats）不得触发 "Maximum update depth exceeded"。
 *
 * 根因：zustand v5 useSyncExternalStore 的 selector 每次返回**新引用**
 * （`s.ccHidden || []`、`{ agentId, source }` 对象字面量）→ 挂载时快照变化 →
 * forceStoreRerender 无限循环。修复后 selector 只返回 store 内稳定引用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import ControlCenter from '../ControlCenter'
import { useIdentityStore } from '../../identityStore'
import { resetStores } from '../../test/resetStores'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: () => Promise.resolve(() => {}),
}))

// jsdom 缺 ResizeObserver/scrollIntoView——polyfill 排除环境噪音
class MockResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView = () => {}

describe('ControlCenter 带会话挂载（#185 回归）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    useIdentityStore.setState({
      sessions: [{
        id: 's1', agentId: 'peri', name: 'Demo', source: 'local:demo', profileId: 'profile-a',
        createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
        skills: [], hooks: [], autoName: '',
      }],
      agents: [{ id: 'peri', name: 'Peri' }],
      activeAgent: 'peri',
      profiles: [{ id: 'profile-a', name: 'R', persona: 'p', model: 'm' }],
      activeProfileId: 'profile-a',
    })
  })

  it('带会话挂载不触发 #185（Maximum update depth exceeded）', () => {
    expect(() => render(<ControlCenter sessionId="s1" />)).not.toThrow(/Maximum update depth/)
  })

  it('重复挂载/卸载（模拟切 sheet 重试）不触发 #185', () => {
    // 重试 = 卸载后重新挂载——循环若与状态无关，重挂载仍崩（原 agent sheet 重试无效）
    for (let i = 0; i < 3; i += 1) {
      const { unmount } = render(<ControlCenter sessionId="s1" />)
      unmount()
    }
    expect(true).toBe(true)
  })

  it('非经典 Presentation 显示会话、工作区与运行状态控件；经典终端保持隐藏', () => {
    usePresentationPreferenceStore.setState({ activeProfileId: 'builtin.presentation.terminal-modern' })
    const { container, rerender } = render(<ControlCenter sessionId="s1" />)
    expect(container.querySelector('[data-widget-id="session"]')?.textContent).toContain('Demo')
    expect(container.querySelector('[data-widget-id="workspace"]')?.textContent).toContain('无工作目录')
    expect(container.querySelector('[data-widget-id="activity"]')?.textContent).toContain('就绪')

    usePresentationPreferenceStore.setState({ activeProfileId: 'builtin.presentation.terminal-classic' })
    rerender(<ControlCenter sessionId="s1" />)
    expect(container.querySelector('[data-widget-id="session"]')).toBeNull()
    expect(container.querySelector('[data-widget-id="workspace"]')).toBeNull()
    expect(container.querySelector('[data-widget-id="activity"]')).toBeNull()
  })
})
