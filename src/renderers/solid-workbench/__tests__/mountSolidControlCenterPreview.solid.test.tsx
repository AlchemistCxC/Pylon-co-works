// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { waitFor } from '@solidjs/testing-library'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { createPreviewWorkbenchServices } from '../__fixtures__/previewWorkbenchServices.ts'
import { mountSolidControlCenterPreview } from '../__fixtures__/mountSolidControlCenterPreview.solid.tsx'
import { createBuiltinCcWidgetPluginDefinition } from '../../../plugins/core/cc/builtinCcWidgetPlugin.ts'
import { TestPluginRuntime } from '../../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { getRuntimeServices } from '../../../plugin-runtime/runtimeServices.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('mountSolidControlCenterPreview', () => {
  it('挂载可辨识的 Solid 中控，并响应外观快照后幂等销毁', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const theme = structuredClone(DEFAULTS)
    theme.ccBg = '#123456'
    theme.ccBgImage = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E'
    theme.ccMarginX = 28
    theme.ccMarginBottom = 16
    theme.ccRadius = 12
    theme.ccSurfaceOpacity = 72
    theme.inputOffsetTop = 12
    theme.inputHeight = 44
    theme.inputMarginX = 18
    theme.inputSurfaceBg = '#223344'
    theme.inputSurfaceOpacity = 0.7
    theme.inputRadius = 6
    theme.inputBorder = '#abcdef'
    theme.inputBorderWidth = 3
    theme.inputBorderOpacity = 0.5
    theme.inputFontSize = 18
    theme.inputTextColor = '#fefefe'
    theme.inputPlaceholder = '#aaaaaa'
    services.appearance.setTheme(theme)

    const destroy = mountSolidControlCenterPreview({ host, services })
    cleanups.push(() => {
      destroy()
      services.destroy()
      host.remove()
    })

    const controlCenter = host.querySelector<HTMLElement>('[data-control-center="production"]')
    expect(controlCenter).not.toBeNull()
    expect(controlCenter?.classList.contains('control-center')).toBe(true)
    expect(controlCenter?.style.getPropertyValue('--cc-surface')).toBe('#123456')
    expect(controlCenter?.style.getPropertyValue('--cc-surface-image')).toContain('url(')
    expect(controlCenter?.style.getPropertyValue('--cc-margin-x')).toBe('28px')
    expect(controlCenter?.style.getPropertyValue('--cc-margin-bottom')).toBe('16px')
    expect(controlCenter?.style.getPropertyValue('--cc-radius')).toBe('12px')
    expect(controlCenter?.style.getPropertyValue('--cc-surface-opacity')).toBe('72%')
    expect(controlCenter?.style.getPropertyValue('--cc-input-offset-top')).toBe('12px')
    expect(controlCenter?.style.getPropertyValue('--cc-input-height')).toBe('44px')
    expect(controlCenter?.style.getPropertyValue('--cc-input-margin-x')).toBe('18px')
    expect(controlCenter?.style.getPropertyValue('--cc-input-surface')).toBe('#223344')
    expect(controlCenter?.style.getPropertyValue('--cc-input-surface-opacity')).toBe('70%')
    expect(controlCenter?.style.getPropertyValue('--cc-input-radius')).toBe('6px')
    expect(controlCenter?.style.getPropertyValue('--cc-input-border')).toBe('#abcdef')
    expect(controlCenter?.style.getPropertyValue('--cc-input-border-width')).toBe('3px')
    expect(controlCenter?.style.getPropertyValue('--cc-input-border-opacity')).toBe('50%')
    expect(controlCenter?.style.getPropertyValue('--cc-input-font-size')).toBe('18px')
    expect(controlCenter?.style.getPropertyValue('--cc-input-text')).toBe('#fefefe')
    expect(controlCenter?.style.getPropertyValue('--cc-input-placeholder')).toBe('#aaaaaa')
    expect(controlCenter?.style.getPropertyValue('--cc-bg-height')).toBe('')

    const nextTheme = {
      ...theme,
      ccBg: '#abcdef',
      ccBgImage: '',
      ccMarginX: 36,
      ccMarginBottom: 20,
      ccRadius: 18,
      ccSurfaceOpacity: 48,
      inputOffsetTop: 20,
      inputHeight: 38,
      inputMarginX: 22,
      inputSurfaceBg: '#334455',
      inputSurfaceOpacity: 0.4,
      inputRadius: 8,
      inputBorder: '#fedcba',
      inputBorderWidth: 2,
      inputBorderOpacity: 0.3,
      inputFontSize: 16,
      inputTextColor: '#eeeeee',
      inputPlaceholder: '#999999',
    }
    services.appearance.setTheme(nextTheme)
    await waitFor(() => {
      expect(controlCenter?.style.getPropertyValue('--cc-surface')).toBe('#abcdef')
      expect(controlCenter?.style.getPropertyValue('--cc-surface-image')).toBe('none')
      expect(controlCenter?.style.getPropertyValue('--cc-margin-x')).toBe('36px')
      expect(controlCenter?.style.getPropertyValue('--cc-margin-bottom')).toBe('20px')
      expect(controlCenter?.style.getPropertyValue('--cc-radius')).toBe('18px')
      expect(controlCenter?.style.getPropertyValue('--cc-surface-opacity')).toBe('48%')
      expect(controlCenter?.style.getPropertyValue('--cc-input-offset-top')).toBe('20px')
      expect(controlCenter?.style.getPropertyValue('--cc-input-height')).toBe('38px')
      expect(controlCenter?.style.getPropertyValue('--cc-input-margin-x')).toBe('22px')
      expect(controlCenter?.style.getPropertyValue('--cc-input-surface')).toBe('#334455')
      expect(controlCenter?.style.getPropertyValue('--cc-input-surface-opacity')).toBe('40%')
      expect(controlCenter?.style.getPropertyValue('--cc-input-radius')).toBe('8px')
      expect(controlCenter?.style.getPropertyValue('--cc-input-border')).toBe('#fedcba')
      expect(controlCenter?.style.getPropertyValue('--cc-input-border-width')).toBe('2px')
      expect(controlCenter?.style.getPropertyValue('--cc-input-border-opacity')).toBe('30%')
      expect(controlCenter?.style.getPropertyValue('--cc-input-font-size')).toBe('16px')
      expect(controlCenter?.style.getPropertyValue('--cc-input-text')).toBe('#eeeeee')
      expect(controlCenter?.style.getPropertyValue('--cc-input-placeholder')).toBe('#999999')
    })

    destroy()
    destroy()
    expect(host.childElementCount).toBe(0)
  })

  it('光环投影独立于常态阴影（A6-1-FIX 1.3）：关阴影光环仍在，关光环后变量退场', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const theme = structuredClone(DEFAULTS)
    theme.inputShadowEnabled = 'hidden'
    theme.inputFocusRingEnabled = 'shown'
    services.appearance.setTheme(theme)

    const destroy = mountSolidControlCenterPreview({ host, services })
    cleanups.push(() => {
      destroy()
      services.destroy()
      host.remove()
    })

    const controlCenter = host.querySelector<HTMLElement>('[data-control-center="production"]')
    expect(controlCenter).not.toBeNull()
    expect(controlCenter?.style.getPropertyValue('--cc-input-shadow')).toBe('none')
    expect(controlCenter?.style.getPropertyValue('--cc-input-focus-ring-shadow')).toContain('var(--cc-input-focus-ring-color')

    services.appearance.setTheme({ ...theme, inputFocusRingEnabled: 'hidden' })
    await waitFor(() => {
      expect(controlCenter?.style.getPropertyValue('--cc-input-focus-ring-shadow')).toBe('')
      expect(controlCenter?.style.getPropertyValue('--cc-input-shadow')).toBe('none')
    })
  })

  it('注册发送控件后按位置渲染底层块，hidden 时不渲染并注入几何变量', async () => {
    const runtime = new TestPluginRuntime()
    const instance = await runtime.activateBuiltin(createBuiltinCcWidgetPluginDefinition())
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const theme = structuredClone(DEFAULTS)
    theme.inputSubmitButtonMode = 'inline'
    theme.inputHeight = 50
    theme.inputOffsetTop = 12
    theme.inputMarginX = 16
    theme.sendButtonColor = '#123456'
    theme.sendButtonRadius = '0.25'
    services.appearance.setTheme(theme)

    try {
      expect(getRuntimeServices().ccWidgetRegistry.getSnapshot().entries.map(entry => entry.value.id)).toContain('cc-send-button')
      const destroy = mountSolidControlCenterPreview({ host, services })
      const controlCenter = host.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(controlCenter).not.toBeNull()
      const button = controlCenter?.querySelector<HTMLButtonElement>('.cc-send-button')
      expect(button).not.toBeNull()
      expect(button).toHaveAttribute('data-mode', 'inline')
      expect(controlCenter?.style.getPropertyValue('--cc-send-size')).toBe('calc(var(--cc-input-height) * 0.8)')
      expect(controlCenter?.style.getPropertyValue('--cc-send-color')).toBe('#123456')
      expect(controlCenter?.style.getPropertyValue('--cc-send-radius')).toBe('25%')
      expect(controlCenter?.style.getPropertyValue('--cc-input-text-right-inset')).toContain('0.9')

      services.appearance.setTheme({ ...theme, inputSubmitButtonMode: 'external' })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-send-button')).toHaveAttribute('data-mode', 'external'))
      expect(controlCenter?.style.getPropertyValue('--cc-send-size')).toBe('calc(var(--cc-input-height) * 1)')
      expect(controlCenter?.style.getPropertyValue('--cc-input-text-right-inset')).toBe('var(--cc-input-text-inset-x, 5%)')

      services.appearance.setTheme({ ...theme, inputSubmitButtonMode: 'hidden' })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-send-button')).toBeNull())
      destroy()
    } finally {
      services.destroy()
      host.remove()
      await runtime.deactivate(instance.identity.key)
    }
  })
})
