// @vitest-environment jsdom
// 刀5（#201，UI 二次修订 2026-09-19）：预设区不放「GUI / 终端」选项按钮——直接显示
// 当前界面模式对应的预设（presetsForInterfaceMode），随模式切换自动跟随；
// tactical-blue（不在归属表内）⇒ 预设组不出现。
import { act, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSettingsSheet } from '../../test/settingsSheetHarness'
import { resetStores } from '../../test/resetStores.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({ default: () => <div /> }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const GUI_LABELS = ['Glass Light', 'Solarized Light', 'Agent 指挥台', 'Agent 关系图', '专注流程']
const TERMINAL_LABELS = ['Claude 风格', 'Nord Frost', 'Tokyo Night', 'Amber CRT', 'Matrix 磷绿']

function presetGroup() {
  const title = screen.getByText('全局预设')
  return within(title.closest('.set-group') as HTMLElement)
}

describe('Settings 全局预设菜单（#201）', () => {
  beforeEach(() => {
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('modern-gui 下直接显示 GUI 桶的 5 个预设，终端桶不出现；顺序 = 界面模式在前、全局预设紧随其下', () => {
    mountSettingsSheet()
    const group = presetGroup()
    for (const label of GUI_LABELS) expect(group.getByRole('button', { name: label })).toBeInTheDocument()
    for (const label of TERMINAL_LABELS) expect(group.queryByRole('button', { name: label })).not.toBeInTheDocument()
    // 预设区内无「GUI / 终端」选项按钮（UI 二次修订）
    expect(group.queryByRole('radio')).not.toBeInTheDocument()
    expect(group.queryByRole('button', { name: 'GUI' })).not.toBeInTheDocument()
    expect(group.queryByRole('button', { name: '终端' })).not.toBeInTheDocument()
    const body = document.querySelector('.settings-body') as HTMLElement
    const groupTitles = [...body.querySelectorAll('.set-group-title')]
      .map(el => el.textContent?.replace(/^[▾▸]/, '').trim())
    // 顺序三次修订（2026-09-19）：界面模式在前、全局预设紧随其下
    expect(groupTitles.indexOf('界面模式')).toBeGreaterThanOrEqual(0)
    expect(groupTitles.indexOf('全局预设')).toBeGreaterThan(groupTitles.indexOf('界面模式'))
  })

  it('界面模式 modern-gui ⇄ terminal-like 切换 ⇒ 第二级跟随换桶', () => {
    mountSettingsSheet()
    expect(presetGroup().getByRole('button', { name: 'Glass Light' })).toBeInTheDocument()
    act(() => { useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' }) })
    let group = presetGroup()
    for (const label of TERMINAL_LABELS) expect(group.getByRole('button', { name: label })).toBeInTheDocument()
    for (const label of GUI_LABELS) expect(group.queryByRole('button', { name: label })).not.toBeInTheDocument()
    act(() => { useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' }) })
    group = presetGroup()
    expect(group.getByRole('button', { name: 'Glass Light' })).toBeInTheDocument()
    expect(group.queryByRole('button', { name: 'Claude 风格' })).not.toBeInTheDocument()
  })

  it('tactical-blue 不在归属表内：预设组不出现（拍板：菜单不出现）', () => {
    useInterfaceModeStore.setState({ interfaceMode: 'tactical-blue' })
    mountSettingsSheet()
    expect(screen.queryByText('全局预设')).not.toBeInTheDocument()
    // 界面模式 Group 保持原样
    expect(screen.getByText('界面模式')).toBeInTheDocument()
  })
})
