// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import SettingsSectionHeader from '../SettingsSectionHeader.tsx'

/** K-1：Owner 头（owner id 纯文字 D1-A + pageOwned 徽标 + 密度档三选）。 */

describe('SettingsSectionHeader', () => {
  it('组件 owner section 显示 owner id', () => {
    render(<SettingsSectionHeader section="chat" density="standard" onDensity={() => {}} />)
    expect(screen.getByTestId('settings-owner-badge').textContent).toContain('message-stream')
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
    expect(screen.getByRole('combobox', { name: '显示详细度' })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: '显示详细度' }), { target: { value: 'all' } })
    expect(seen).toEqual(['all'])
  })

  it('当前密度档为选中值', () => {
    render(<SettingsSectionHeader section="chat" density="basic" onDensity={() => {}} />)
    const select = screen.getByRole('combobox', { name: '显示详细度' }) as HTMLSelectElement
    expect(select.value).toBe('basic')
  })
})
