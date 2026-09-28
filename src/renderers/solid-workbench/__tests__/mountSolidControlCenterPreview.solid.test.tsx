// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, waitFor } from '@solidjs/testing-library'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { CC_WIDGET_LABELS, EMPTY_STATE_HIDDEN_WIDGET_IDS } from '../../../domains/cc/widgetDefinitions.ts'
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

    const destroy = mountSolidControlCenterPreview({ host, services, sessionId: 'preview-session' })
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

    const destroy = mountSolidControlCenterPreview({ host, services, sessionId: 'preview-session' })
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
    expect(theme.sendButtonBorderColor).toBe('rgba(255,255,255,.5)')
    expect(theme.sendButtonIcon).toBe('arrow')
    expect(theme.sendButtonIconGenerating).toBe('square')
    expect(theme.sendButtonIconRound).toBe('on')
    expect(theme.sendButtonIconColor).toBe('#ffffff')
    services.runtime.update({ generating: false })
    services.appearance.setTheme(theme)

    try {
      expect(getRuntimeServices().ccWidgetRegistry.getSnapshot().entries.map(entry => entry.value.id)).toContain('cc-send-button')
      const destroy = mountSolidControlCenterPreview({ host, services, sessionId: 'preview-session' })
      const controlCenter = host.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(controlCenter).not.toBeNull()
      const button = controlCenter?.querySelector<HTMLButtonElement>('.cc-send-button')
      expect(button).not.toBeNull()
      expect(button).toHaveAttribute('data-mode', 'inline')
      expect(controlCenter?.style.getPropertyValue('--cc-send-size')).toBe('calc(var(--cc-input-height) * 0.8)')
      expect(controlCenter?.style.getPropertyValue('--cc-send-color')).toBe('#123456')
      expect(controlCenter?.style.getPropertyValue('--cc-send-radius')).toBe('25%')
      expect(controlCenter?.style.getPropertyValue('--cc-send-border-color')).toBe('rgba(255,255,255,.5)')
      expect(controlCenter?.style.getPropertyValue('--cc-send-icon-color')).toBe('#ffffff')
      const initialPath = controlCenter?.querySelector('.cc-send-icon path')?.getAttribute('d')
      expect(initialPath).toContain('M12 20 V4.5')
      expect(controlCenter?.style.getPropertyValue('--cc-input-text-right-inset')).toContain('0.9')

      services.appearance.setTheme({ ...theme, sendButtonBorderColor: 'rgba(0,0,0,.5)', inputSubmitButtonMode: 'external' })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-send-button')).toHaveAttribute('data-mode', 'external'))
      expect(controlCenter?.style.getPropertyValue('--cc-send-size')).toBe('calc(var(--cc-input-height) * 1)')
      expect(controlCenter?.style.getPropertyValue('--cc-send-border-color')).toBe('rgba(0,0,0,.5)')
      expect(controlCenter?.style.getPropertyValue('--cc-send-icon-color')).toBe('#ffffff')
      services.appearance.setTheme({ ...theme, sendButtonIconColor: 'rgba(0,0,0,.5)', inputSubmitButtonMode: 'external' })
      await waitFor(() => expect(controlCenter?.style.getPropertyValue('--cc-send-icon-color')).toBe('rgba(0,0,0,.5)'))
      services.appearance.setTheme({ ...theme, sendButtonIconColor: '#000000', inputSubmitButtonMode: 'external' })
      await waitFor(() => expect(controlCenter?.style.getPropertyValue('--cc-send-icon-color')).toBe('#000000'))
      services.runtime.update({ generating: true })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-send-icon path')?.getAttribute('d')).not.toBe(initialPath))
      services.runtime.update({ generating: false })
      services.appearance.setTheme({ ...theme, sendButtonIcon: 'triangle', sendButtonIconRound: 'off', inputSubmitButtonMode: 'external' })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-send-icon path')?.getAttribute('d')).toBe('M12 8.25 L19.5 15.75 H4.5 Z'))
      services.appearance.setTheme({ ...theme, sendButtonIcon: 'triangle', sendButtonIconRound: 'on', inputSubmitButtonMode: 'external' })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-send-icon path')?.getAttribute('d')).toContain('A1.5 1.5'))
      expect(controlCenter?.querySelector('.cc-send-icon')).toHaveAttribute('aria-hidden', 'true')
      expect(controlCenter?.querySelector('.cc-send-icon')).toHaveClass('cc-send-icon--lg')
      services.runtime.update({ generating: true })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-send-icon path')).toHaveAttribute('d', 'M7.5 6 H16.5 A1.5 1.5 0 0 1 18 7.5 V16.5 A1.5 1.5 0 0 1 16.5 18 H7.5 A1.5 1.5 0 0 1 6 16.5 V7.5 A1.5 1.5 0 0 1 7.5 6 Z'))
      services.appearance.setTheme({ ...theme, sendButtonIconRound: 'off', inputSubmitButtonMode: 'external' })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-send-icon path')).toHaveAttribute('d', 'M6 6 H18 V18 H6 Z'))
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

  it('04b 空态极简：发送按钮空态隐藏、编辑态下**仍不在场**，选择器始终不显示', async () => {
    const runtime = new TestPluginRuntime()
    const instance = await runtime.activateBuiltin(createBuiltinCcWidgetPluginDefinition())
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const theme = structuredClone(DEFAULTS)
    theme.inputSubmitButtonMode = 'inline'
    services.appearance.setTheme(theme)

    try {
      const destroy = mountSolidControlCenterPreview({ host, services, sessionId: null })
      const controlCenter = host.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(controlCenter).not.toBeNull()
      // 空态：注册轨发送按钮与状态控件都不渲染；工作区选择器也不显示
      expect(controlCenter?.querySelector('.cc-send-button')).toBeNull()
      expect(controlCenter?.querySelectorAll('[data-widget-id]:not([data-widget-id="input"])')).toHaveLength(0)
      expect(controlCenter?.querySelector('[aria-label="新会话工作区"]')).toBeNull()

      services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

      // ★ 刀1 反转自 CC-02「编辑模式豁免」：空态名单里的件进了编辑态**同样不在场**
      //   （正控：编辑工具栏必须已出现，否则"仍然为空"是假绿）
      await waitFor(() => expect(controlCenter?.querySelector('.cc-edit-toolbar')).not.toBeNull())
      expect(controlCenter?.querySelector('.cc-send-button')).toBeNull()
      expect(controlCenter?.querySelector('[data-widget-id="model"]')).toBeNull()
      // 甲：选择器在编辑态仍不显示
      expect(controlCenter?.querySelector('[aria-label="新会话工作区"]')).toBeNull()
      destroy()
    } finally {
      services.destroy()
      host.remove()
      await runtime.deactivate(instance.identity.key)
    }
  })

  it('★ 刀1：编辑态下被预设 ccHidden 藏起来的发送按钮**不在场**（DOM 缺失）', async () => {
    const runtime = new TestPluginRuntime()
    const instance = await runtime.activateBuiltin(createBuiltinCcWidgetPluginDefinition())
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const theme = structuredClone(DEFAULTS)
    theme.inputSubmitButtonMode = 'inline'
    theme.ccHidden = ['cc-send-button']
    services.appearance.setTheme(theme)

    try {
      const destroy = mountSolidControlCenterPreview({ host, services, sessionId: 'preview-session' })
      const controlCenter = host.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(controlCenter).not.toBeNull()
      // 非编辑态：预设把它藏了 ⇒ 不在场
      expect(controlCenter?.querySelector('.cc-send-button')).toBeNull()

      services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

      // ★ 本刀的核心行为：编辑态不再豁免 ⇒ 被藏件在 DOM 里**不存在**。
      //   ★ 反转自 CC-02 旧断言（编辑态「在场 + 淡显」）。
      //   正控：编辑工具栏必须已出现，否则"仍然为空"是假绿。
      await waitFor(() => expect(controlCenter?.querySelector('.cc-edit-toolbar')).not.toBeNull())
      expect(controlCenter?.querySelector('.cc-send-button')).toBeNull()
      destroy()
    } finally {
      services.destroy()
      host.remove()
      await runtime.deactivate(instance.identity.key)
    }
  })

  it('★ 刀1：清单是隐藏件唯一入口 —— 被藏件不在场、清单如实说「已隐藏」、点「显示」它回来', async () => {
    const runtime = new TestPluginRuntime()
    const instance = await runtime.activateBuiltin(createBuiltinCcWidgetPluginDefinition())
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const theme = structuredClone(DEFAULTS)
    theme.inputSubmitButtonMode = 'inline'
    theme.ccHidden = ['model']
    services.appearance.setTheme(theme)

    try {
      const destroy = mountSolidControlCenterPreview({ host, services, sessionId: 'preview-session' })
      const controlCenter = host.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(controlCenter).not.toBeNull()

      services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })
      await waitFor(() => expect(controlCenter?.querySelector('.cc-edit-toolbar')).not.toBeNull())

      // 画布上不存在（新语义：它回来了才说明清单这个入口真的管用）
      expect(controlCenter?.querySelector('[data-widget-id="model"]')).toBeNull()

      // 清单如实：该格标 dim、开关写着「显示 X」
      const chipWrap = (id: string) => [...(controlCenter?.querySelectorAll<HTMLElement>('.cc-edit-toolbar-chip-wrap') ?? [])]
        .find(wrap => wrap.textContent?.includes(CC_WIDGET_LABELS[id as keyof typeof CC_WIDGET_LABELS]))
      expect(chipWrap('model')?.classList.contains('dim')).toBe(true)
      const toggle = chipWrap('model')?.querySelector<HTMLButtonElement>('.cc-chip-toggle')
      expect(toggle?.getAttribute('aria-label')).toBe('显示 模型')

      // 点清单的「显示」⇒ 它出现在场
      fireEvent.click(toggle as HTMLButtonElement)
      await waitFor(() => expect(controlCenter?.querySelector('[data-widget-id="model"]')).not.toBeNull())
      destroy()
    } finally {
      services.destroy()
      host.remove()
      await runtime.deactivate(instance.identity.key)
    }
  })

  it('CC-02 第 5 步收口：工具栏那一格与控件同源 —— 被空态名单藏起来的件显示为「已隐藏」', async () => {
    const runtime = new TestPluginRuntime()
    const instance = await runtime.activateBuiltin(createBuiltinCcWidgetPluginDefinition())
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    const theme = structuredClone(DEFAULTS)
    theme.inputSubmitButtonMode = 'inline'
    services.appearance.setTheme(theme)

    try {
      const destroy = mountSolidControlCenterPreview({ host, services, sessionId: null })
      const controlCenter = host.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(controlCenter).not.toBeNull()
      // 前提：这里是**空态语境名单**在藏件，预设值 ccHidden 里一件都没有。
      // ⇒ 工具栏若读裸预设值，就会把这几格报成「● 显示着」——同一个事实两处判据，正是本单病灶。
      expect(theme.ccHidden).not.toContain('model')

      services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

      const chipWrap = (id: string) => [...(controlCenter?.querySelectorAll<HTMLElement>('.cc-edit-toolbar-chip-wrap') ?? [])]
        .find(wrap => wrap.textContent?.includes(CC_WIDGET_LABELS[id as keyof typeof CC_WIDGET_LABELS]))
      const chipMark = (id: string) => chipWrap(id)?.querySelector('.cc-edit-toolbar-chip')?.textContent?.trim().at(0)

      // 名单里的每一件：工具栏那一格如实说「隐藏」（＋ / dim）—— ★ 刀1 起画布上它已不在场，
      // 清单是它唯一的入口，故这里的"如实"就是隐藏件的全部可见信息。
      await waitFor(() => expect(chipWrap('model')?.classList.contains('dim')).toBe(true))
      for (const id of EMPTY_STATE_HIDDEN_WIDGET_IDS) {
        expect(chipWrap(id)?.classList.contains('dim')).toBe(true)
        expect(chipMark(id)).toBe('＋')
      }
      // 不在名单里的输入栏仍是「● 显示着」—— 挡住"这条用例恒为全部隐藏"
      expect(chipWrap('input')?.classList.contains('dim')).toBe(false)
      expect(chipMark('input')).toBe('●')
      destroy()
    } finally {
      services.destroy()
      host.remove()
      await runtime.deactivate(instance.identity.key)
    }
  })

})
