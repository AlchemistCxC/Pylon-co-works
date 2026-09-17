// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import SettingsSectionHeader from '../SettingsSectionHeader.tsx'

/** K-1：Owner 头（owner 展示名 + pageOwned 徽标 + 密度档三选）。 */

describe('SettingsSectionHeader', () => {
  it('组件 owner section 显示可读名，原始 id 留在 data-owner', () => {
    // #116 子项 4d：原先徽标文本直接是内部 id（`· message-stream`），与同位置的
    // 「设置页」徽标两种语法并存；现改显示可读名，id 由 data-owner 承载。
    render(<SettingsSectionHeader section="chat" density="standard" onDensity={() => {}} />)
    const badge = screen.getByTestId('settings-owner-badge')
    expect(badge.textContent).toContain('消息流组件')
    expect(badge.textContent).not.toContain('message-stream')
    expect(badge.getAttribute('data-owner')).toBe('message-stream')
  })

  it('页面自有 section 显示「设置页」徽标而非 owner id', () => {
    render(<SettingsSectionHeader section="window" density="standard" onDensity={() => {}} />)
    expect(screen.getByTestId('settings-owner-badge').textContent).toContain('设置页')
    expect(screen.getByTestId('settings-owner-badge').textContent).not.toContain('app-shell')
  })

  it('未登记 owner 的功能面板 section（agent/session 等）显示「设置页」徽标', () => {
    render(<SettingsSectionHeader section="gateway" density="standard" onDensity={() => {}} />)
    expect(screen.getByTestId('settings-owner-badge').textContent).toContain('设置页')
  })

  it('密度档三选项，点击回调新档位', () => {
    const seen: string[] = []
    render(<SettingsSectionHeader section="chat" density="standard" onDensity={d => seen.push(d)} />)
    // K-3 优化：密度档换 ui/Select（combobox trigger + listbox 弹层）
    fireEvent.click(screen.getByRole('combobox', { name: '显示详细度' }))
    // ui/Select 的 option 在 mousedown 选择（防 blur 竞态）
    fireEvent.mouseDown(screen.getByRole('option', { name: '全部' }))
    expect(seen).toEqual(['all'])
  })

  it('当前密度档为选中值（trigger 文本反映当前档）', () => {
    render(<SettingsSectionHeader section="chat" density="basic" onDensity={() => {}} />)
    expect(screen.getByRole('combobox', { name: '显示详细度' }).textContent).toContain('基础')
  })
})
