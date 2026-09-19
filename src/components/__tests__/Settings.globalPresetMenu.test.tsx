// @vitest-environment jsdom
// 刀5（#201）：全局预设两级菜单——第一级 GUI/终端 过滤、第二级归属相符 chips；
// tactical-blue（不在归属表内）⇒ 预设组不出现。
import { fireEvent, screen, within } from '@testing-library/react'
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

describe('Settings 全局预设两级菜单（#201）', () => {
  beforeEach(() => {
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('modern-gui 下默认显示 GUI 桶的 5 个预设，终端桶不出现', () => {
    mountSettingsSheet()
    const group = presetGroup()
    for (const label of GUI_LABELS) expect(group.getByRole('button', { name: label })).toBeInTheDocument()
    for (const label of TERMINAL_LABELS) expect(group.queryByRole('button', { name: label })).not.toBeInTheDocument()
    // 预设区是正文第一个 Group（在「界面模式」之前）
    const body = document.querySelector('.settings-body') as HTMLElement
    const groupTitles = [...body.querySelectorAll('.set-group-title')]
      .map(el => el.textContent?.replace(/^[▾▸]/, '').trim())
    expect(groupTitles.indexOf('全局预设')).toBeGreaterThanOrEqual(0)
    expect(groupTitles.indexOf('全局预设')).toBeLessThan(groupTitles.indexOf('界面模式'))
  })

  it('点「终端」过滤选项后第二级换成终端桶，且不切换界面模式', () => {
    mountSettingsSheet()
    fireEvent.click(presetGroup().getByRole('radio', { name: '终端' }))
    const group = presetGroup()
    for (const label of TERMINAL_LABELS) expect(group.getByRole('button', { name: label })).toBeInTheDocument()
    for (const label of GUI_LABELS) expect(group.queryByRole('button', { name: label })).not.toBeInTheDocument()
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
  })

  it('tactical-blue 不在归属表内：预设组不出现（拍板：菜单不出现）', () => {
    useInterfaceModeStore.setState({ interfaceMode: 'tactical-blue' })
    mountSettingsSheet()
    expect(screen.queryByText('全局预设')).not.toBeInTheDocument()
    // 界面模式 Group 保持原样
    expect(screen.getByText('界面模式')).toBeInTheDocument()
  })
})
