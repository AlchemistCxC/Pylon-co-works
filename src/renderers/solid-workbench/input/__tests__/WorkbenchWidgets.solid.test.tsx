// @vitest-environment jsdom
import { createSignal, onCleanup, type JSX } from 'solid-js'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../../domains/theme/themeDefaults.ts'
import { createPreviewWorkbenchServices } from '../../__fixtures__/previewWorkbenchServices.ts'
import { SolidWorkbenchContext, type SolidWorkbenchContextValue } from '../../SolidWorkbenchContext.solid.tsx'
import { SolidAttachWidget, SolidModeWidget, SolidModelWidget, SolidSendWidget } from '../WorkbenchWidgets.solid.tsx'

const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
})

function renderWidget(view: () => JSX.Element, themePatch: Partial<typeof DEFAULTS> = {}) {
  const services = createPreviewWorkbenchServices()
  services.runtime.update({ generating: false, streamingText: '', streamingThinking: '' })
  const theme = structuredClone(DEFAULTS)
  services.appearance.setTheme({ ...theme, ...themePatch })
  servicesList.push(services)
  const [runtimeSnapshot, setRuntimeSnapshot] = createSignal(services.runtime.getSnapshot())
  const [appearanceSnapshot, setAppearanceSnapshot] = createSignal(services.appearance.getSnapshot())
  const context: SolidWorkbenchContextValue = {
    input: () => ({ sheetId: 'sheet-a', sessionId: 'preview-session', preview: true }),
    runtime: services.runtime,
    runtimeSnapshot,
    appearance: services.appearance,
    appearanceSnapshot,
    sessionUi: services.sessionUi,
    commands: services.commands,
    paused: () => false,
  }
  render(() => {
    const unsubscribeRuntime = services.runtime.subscribe(() => setRuntimeSnapshot(services.runtime.getSnapshot()))
    const unsubscribeAppearance = services.appearance.subscribe(() => setAppearanceSnapshot(services.appearance.getSnapshot()))
    onCleanup(() => {
      unsubscribeRuntime()
      unsubscribeAppearance()
    })
    return <SolidWorkbenchContext.Provider value={context}>{view()}</SolidWorkbenchContext.Provider>
  })
  return services
}

describe('Solid Workbench widgets', () => {
  it('Model dropdown 枚举 runtime models，并经 facade 切换', async () => {
    const services = renderWidget(() => <SolidModelWidget />, { modelVariant: 'dropdown' })
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-flash/ }))
    expect(screen.getByRole('listbox', { name: '模型列表' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-v4-pro' }))

    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('setModel'))
    expect(services.commands.calls[0]?.args).toEqual(['preview-session', 'deepseek-v4-pro'])
  })

  it('空态即使 preset 是 minimal/badge 也强制提供模型与思考等级下拉', async () => {
    const services = renderWidget(
      () => <SolidModelWidget
        forceDropdown
        draftValue={() => 'deepseek-v4-flash'}
        onDraftChange={() => {}}
        reasoningValue={() => 'medium'}
        onReasoningChange={() => {}}
      />,
      { modelVariant: 'badge' },
    )
    const trigger = screen.getByRole('button', { name: /deepseek-v4-flash/ })
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    fireEvent.click(trigger)
    expect(screen.getByRole('group', { name: '思考强度' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'xhigh' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'deepseek-v4-pro' })).toBeTruthy()
    services.destroy()
  })

  it('思考等级选项保留原始 id，显示格式为模型（思考等级）', () => {
    const selected: string[] = []
    renderWidget(() => <SolidModelWidget
      forceDropdown
      draftValue={() => 'deepseek-v4-flash'}
      onDraftChange={() => {}}
      reasoningValue={() => 'medium'}
      onReasoningChange={value => selected.push(value)}
    />)
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-flash/ }))
    fireEvent.click(screen.getByRole('option', { name: 'xhigh' }))
    expect(selected).toEqual(['xhigh'])
    expect(screen.getByRole('button', { name: /deepseek-v4-flash（medium）/ })).toBeTruthy()
  })

  it('Model minimal 循环；badge 只读不产生按钮', async () => {
    const minimal = renderWidget(() => <SolidModelWidget />, { modelVariant: 'minimal' })
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    await waitFor(() => expect(minimal.commands.calls[0]?.args).toEqual(['preview-session', 'deepseek-v4-pro']))
    cleanup()
    minimal.destroy()

    renderWidget(() => <SolidModelWidget />, { modelVariant: 'badge' })
    expect(screen.getByText('deepseek-v4-flash').className).toContain('cc-model-badge')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('Mode pill/badge/minimal 保留 class/data-mode，点击循环 mode', async () => {
    const services = renderWidget(() => <SolidModeWidget />, { modeVariant: 'badge' })
    const button = screen.getByRole('button', { name: '[auto]' })
    expect(button.className).toContain('cc-mode-badge')
    expect(button.getAttribute('data-mode')).toBe('auto')
    fireEvent.click(button)

    await waitFor(() => expect(services.commands.calls[0]?.args).toEqual(['preview-session', 'bypass']))
  })

  it('空态 mode 下拉显示全自动但提交 raw auto', async () => {
    const services = renderWidget(() => <SolidModeWidget
      forceDropdown
      draftValue={() => 'auto'}
      onDraftChange={value => services.runtime.update({ activeMode: value })}
    />)
    const trigger = screen.getByRole('button', { name: /全自动/ })
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox', { name: '模式列表' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '全自动' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '接受编辑' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: '绕过确认' }))
    await waitFor(() => expect(services.runtime.getSnapshot().activeMode).toBe('bypass'))
  })

  it('Model/Mode facade 失败显示可见错误', async () => {
    const services = renderWidget(() => <><SolidModelWidget /><SolidModeWidget /></>, {
      modelVariant: 'minimal',
      modeVariant: 'minimal',
    })
    services.commands.setHandler('setModel', vi.fn(async () => ({ ok: false, error: 'model denied' })))
    services.commands.setHandler('setMode', vi.fn(async () => ({ ok: false, error: 'mode denied' })))

    fireEvent.click(screen.getByRole('button', { name: 'deepseek-v4-flash' }))
    fireEvent.click(screen.getByRole('button', { name: 'auto' }))
    expect(await screen.findByText('model denied')).toBeTruthy()
    expect(await screen.findByText('mode denied')).toBeTruthy()
  })

  it('Send variant 派发输入事件；生成中改走 cancel facade', async () => {
    const sendEvent = vi.fn()
    window.addEventListener('pylon:solid-input-send', sendEvent)
    const services = renderWidget(() => <SolidSendWidget />, { sendVariant: 'square' })
    const sendButton = screen.getByRole('button', { name: '发送消息' })
    expect(sendButton.className).toBe('cc-send-square')
    fireEvent.click(sendButton)
    expect(sendEvent).toHaveBeenCalledTimes(1)

    services.runtime.update({ generating: true })
    await waitFor(() => expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    await waitFor(() => expect(services.commands.calls[0]?.command).toBe('cancel'))
    window.removeEventListener('pylon:solid-input-send', sendEvent)
  })

  it('Attach 反映 capability、图片提示与 variant，并派发输入事件', async () => {
    const attachEvent = vi.fn()
    window.addEventListener('pylon:solid-input-attach', attachEvent)
    const services = renderWidget(() => <SolidAttachWidget />, { attachVariant: 'minimal' })
    const attach = screen.getByRole('button', { name: '附件（当前 Agent 不支持图片）' })
    expect(attach.className).toBe('cc-attach-minimal')
    expect(attach.title).toContain('不支持图片')
    fireEvent.click(attach)
    expect(attachEvent).toHaveBeenCalledTimes(1)

    services.runtime.update({ canAttach: false })
    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled())
    window.removeEventListener('pylon:solid-input-attach', attachEvent)
  })
})
