// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SettingsPreview from '../SettingsPreview.tsx'
import { useStore } from '../../store.ts'
import { resetStores } from '../../test/resetStores.ts'

describe('SettingsPreview Solid 中控迁移', () => {
  beforeEach(() => resetStores())

  afterEach(() => resetStores())

  it('挂载 Solid 中控、保留 cc 高亮并实时响应背景主题', async () => {
    const view = render(<SettingsPreview zone="cc" />)
    const controlCenter = await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(node).not.toBeNull()
      return node!
    })

    const ccWrapper = controlCenter.parentElement?.parentElement as HTMLElement | null
    expect(ccWrapper?.style.outline).toContain('solid')

    useStore.setState({ ccBg: '#102030', ccBgImage: 'data:image/png;base64,fixture' })
    await waitFor(() => {
      expect(controlCenter.style.getPropertyValue('--cc-surface')).toBe('#102030')
      expect(controlCenter.style.getPropertyValue('--cc-surface-image')).toContain('url(')
    })

    fireEvent(window, new Event('resize'))
    view.unmount()
    expect(view.container.querySelector('[data-control-center="production"]')).toBeNull()
  })

  it('模板预览读取局部中控背景图与变体变量', async () => {
    const template = document.createElement('div')
    template.className = 'template-preview'
    template.style.setProperty('--cc-bg', '#203040')
    template.style.setProperty('--cc-bg-image', 'data:image/png;base64,template')
    template.style.setProperty('--cc-margin-x', '34')
    template.style.setProperty('--cc-margin-bottom', '18')
    template.style.setProperty('--cc-radius', '14')
    template.style.setProperty('--cc-surface-opacity', '66')
    template.style.setProperty('--cc-input-offset-top', '12')
    template.style.setProperty('--cc-input-height', '42')
    template.style.setProperty('--cc-input-margin-x', '16')
    template.style.setProperty('--cc-input-surface', '#405060')
    template.style.setProperty('--cc-input-surface-opacity', '55')
    template.style.setProperty('--cc-input-radius', '6')
    template.style.setProperty('--cc-input-border', '#506070')
    template.style.setProperty('--cc-input-border-width', '3')
    template.style.setProperty('--cc-input-border-opacity', '45')
    template.style.setProperty('--cc-input-font-size', '18')
    template.style.setProperty('--cc-input-text', '#fafafa')
    template.style.setProperty('--cc-input-placeholder', '#b0b0b0')
    template.style.setProperty('--cc-variant', 'pill')
    document.body.append(template)

    const view = render(<SettingsPreview zone="global" />, { container: template })
    const controlCenter = await waitFor(() => {
      const node = template.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(node).not.toBeNull()
      return node!
    })

    expect(controlCenter.style.getPropertyValue('--cc-surface')).toBe('#203040')
    expect(controlCenter.style.getPropertyValue('--cc-surface-image')).toContain('template')
    expect(controlCenter.style.getPropertyValue('--cc-margin-x')).toBe('34px')
    expect(controlCenter.style.getPropertyValue('--cc-margin-bottom')).toBe('18px')
    expect(controlCenter.style.getPropertyValue('--cc-radius')).toBe('14px')
    expect(controlCenter.style.getPropertyValue('--cc-surface-opacity')).toBe('66%')
    expect(controlCenter.style.getPropertyValue('--cc-input-offset-top')).toBe('12px')
    expect(controlCenter.style.getPropertyValue('--cc-input-height')).toBe('42px')
    expect(controlCenter.style.getPropertyValue('--cc-input-margin-x')).toBe('16px')
    expect(controlCenter.style.getPropertyValue('--cc-input-surface')).toBe('#405060')
    expect(controlCenter.style.getPropertyValue('--cc-input-surface-opacity')).toBe('55%')
    expect(controlCenter.style.getPropertyValue('--cc-input-radius')).toBe('6px')
    expect(controlCenter.style.getPropertyValue('--cc-input-border')).toBe('#506070')
    expect(controlCenter.style.getPropertyValue('--cc-input-border-width')).toBe('3px')
    expect(controlCenter.style.getPropertyValue('--cc-input-border-opacity')).toBe('45%')
    expect(controlCenter.style.getPropertyValue('--cc-input-font-size')).toBe('18px')
    expect(controlCenter.style.getPropertyValue('--cc-input-text')).toBe('#fafafa')
    expect(controlCenter.style.getPropertyValue('--cc-input-placeholder')).toBe('#b0b0b0')
    expect(controlCenter.classList.contains('cc-variant-pill')).toBe(true)

    view.unmount()
    template.remove()
  })
})
