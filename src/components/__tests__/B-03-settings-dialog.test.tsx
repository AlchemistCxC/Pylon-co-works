// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../test/fakeInvoke'
import { mountSettingsSheet } from '../../test/settingsSheetHarness'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({
  default: () => <div data-testid="agent-runtime-panel">runtime onboarding</div>,
}))

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve undefined——语义测试不关心后台 invoke */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

const fakeInvoke = new TolerantFakeInvoke()
invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)

/**
 * #154 阶段 4 改写登记：设置由固定覆盖层迁入 sheet 体系后，原 B-03 的
 * role=dialog / aria-modal / 焦点陷阱 / 关闭钮恢复焦点断言随对话框外壳一并退役
 * （sheet 由页签与 titlebar 关闭，不再自持对话框语义）。本文件改钉 sheet 形态契约：
 * 无对话框语义、导航/正文同树可聚焦、导航点击经 sheet 状态回路驱动正文。
 */
describe('B-03 Settings sheet 语义', () => {
  it('不再是对话框：无 role=dialog / aria-modal，正文直接可聚焦', () => {
    mountSettingsSheet()
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull()
    expect(document.querySelector('.settings[aria-modal]')).toBeNull()
    expect(document.querySelector('.settings-header')).toBeNull()
    expect(screen.queryByRole('button', { name: '关闭设置' })).toBeNull()
  })

  it('默认外观域：正文渲染分区内容，导航与正文均为真实 button', () => {
    mountSettingsSheet()
    expect(screen.getByText('界面模式')).toBeInTheDocument()
    const focusables = [...document.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
    expect(focusables.length).toBeGreaterThan(1)
    for (const button of focusables.slice(0, 5)) expect(button.tabIndex).toBeGreaterThanOrEqual(0)
  })

  it('左栏点击域按钮 → sheet 状态更新（持久化 codec 归一）并驱动正文', () => {
    const view = mountSettingsSheet()
    const nav = document.querySelector('.settings-sheet-nav') as HTMLElement
    fireEvent.click(within(nav).getByRole('button', { name: /工作区/ }))

    expect(view.sheetState().domain).toBe('workspace')
    expect(view.sheetState().section).toBe('window')
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === view.id)?.state).toMatchObject({ domain: 'workspace' })
    // 正文跟随：窗口分区内容（窗口尺寸块）出现
    expect(screen.getByText('当前尺寸')).toBeInTheDocument()
    view.unmount()
  })
})

