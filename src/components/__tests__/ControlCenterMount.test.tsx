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
import { fireEvent, render } from '@testing-library/react'
import ControlCenter from '../ControlCenter'
import { useIdentityStore } from '../../identityStore'
import { resetStores } from '../../test/resetStores'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { useStore } from '../../store.ts'

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

  it('兼容中控属性面板清空数字输入时保留上次有效值', () => {
    useStore.getState().updateCcPlacement('model', { order: 7, offsetX: 12 })
    useStore.getState().setCcScale('model', 125)
    useStore.getState().setCcEditMode(true)
    const { container, getByRole } = render(<ControlCenter sessionId="s1" />)
    fireEvent.click(getByRole('button', { name: '● 模型' }))

    const numberInput = (label: string) => {
      const field = Array.from(container.querySelectorAll('.cc-prop-field'))
        .find(element => element.querySelector('label')?.textContent === label)
      return field?.querySelector<HTMLInputElement>('input[type="number"]')
    }
    fireEvent.change(numberInput('顺序')!, { target: { value: '' } })
    fireEvent.change(numberInput('水平微调')!, { target: { value: '' } })
    fireEvent.change(numberInput('缩放')!, { target: { value: '' } })

    expect(useStore.getState().ccLayout.placements.model).toMatchObject({ order: 7, offsetX: 12 })
    expect(useStore.getState().ccScale.model).toBe(125)
  })

  it('兼容中控恢复控件后同步抬高持久化高度', () => {
    useStore.setState({
      inputMode: 'cli', inputVariant: 'cli', footerLayout: 'peri', cliHintMode: 'full',
      ccHeight: 84, ccBgHeight: 84,
      ccHidden: ['session', 'workspace', 'activity', 'pct', 'tokens', 'send', 'attach', 'tasks'],
    })

    useStore.getState().setCcHidden('pct', false)
    useStore.getState().setCcHidden('tokens', false)

    expect(useStore.getState()).toMatchObject({ ccHeight: 109, ccBgHeight: 109 })
  })

  it('兼容中控切换 CLI 布局后同步抬高持久化高度', () => {
    useStore.setState({
      inputMode: 'default', inputVariant: 'composer', footerLayout: 'peri', cliHintMode: 'full',
      ccHeight: 64, ccBgHeight: 64, ccEditMode: true,
    })
    const { getByRole } = render(<ControlCenter sessionId="s1" />)
    fireEvent.click(getByRole('button', { name: '● 输入栏' }))
    fireEvent.click(getByRole('button', { name: '命令行' }))

    expect(useStore.getState()).toMatchObject({ inputMode: 'cli', inputVariant: 'cli', ccHeight: 109, ccBgHeight: 109 })
  })

  it('兼容中控控件拖拽只响应发起拖拽的 pointer', () => {
    useStore.getState().setCcEditMode(true)
    const { container } = render(<ControlCenter sessionId="s1" />)
    const model = container.querySelector<HTMLElement>('[data-widget-id="model"]')!

    fireEvent.pointerDown(model, { clientX: 10, clientY: 20, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40, pointerId: 2 })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(useStore.getState().ccLayout.placements.model).toMatchObject({ offsetX: 0, offsetY: 0 })

    fireEvent.pointerMove(window, { clientX: 34, clientY: 12, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(useStore.getState().ccLayout.placements.model).toMatchObject({ offsetX: 24, offsetY: -8 })
  })
})
