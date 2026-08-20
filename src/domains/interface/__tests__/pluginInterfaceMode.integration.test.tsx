// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../../../plugin-runtime/pluginCompositionRoot.ts'
import { activateInterfaceMode, ensureInterfaceModeProfile } from '../../../application/transactions/activateInterfaceMode.ts'
import InterfaceModePicker from '../../../components/settings/InterfaceModePicker.tsx'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { getInterfaceModeRegistry, getPluginUiRegistry, getPresentationProfileRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import AgentSheetView from '../../../sheets/AgentSheetView.tsx'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes.ts'
import { usePresentationPreferenceStore } from '../../presentation/presentationPreferenceStore.ts'
import { useInterfaceModeStore } from '../interfaceModeStore.ts'

const registrations: AsyncDisposable[] = []
const ctx: SheetContext = {
  openSheet: () => 'x', focusSheet() {}, closeSheet() {},
  activeSession: 'session-1', selectSession() {}, openProfileEdit() {}, openSessionSettings() {},
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false,
  sessionSource: () => 'local:s1', sessionBySource: () => undefined,
}
const sheet: SheetRecord = {
  id: 'agent-sheet', kind: 'agent', title: 'Peri', agentId: 'peri',
  createdAt: 1, lastFocusedAt: 1, state: { sidebarMode: 'chat' },
}

describe('plugin Interface Mode integration', () => {
  beforeEach(() => {
    localStorage.clear()
    useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
    usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)
  })

  afterEach(async () => {
    while (registrations.length > 0) await registrations.pop()?.dispose()
    ensureInterfaceModeProfile()
  })

  it('第三种模式进入设置选择器并挂载隔离 Agent workbench；卸载后回退默认模式', async () => {
    const owner = createPluginIdentity('example.focus', 'integration')
    registrations.push(getPluginUiRegistry().register(owner, {
      id: 'example.focus.workbench',
      reactVersion: '19',
      mount(container, bridge) {
        const title = document.createElement('strong')
        title.textContent = 'FOCUS WORKBENCH'
        const input = document.createElement('pre')
        input.dataset.testid = 'focus-input'
        container.append(title, input)
        const off = bridge.on('host:input', value => { input.textContent = JSON.stringify(value) })
        return () => { off(); container.replaceChildren() }
      },
    }))
    registrations.push(getPresentationProfileRegistry().register(owner, {
      id: 'example.presentation.focus', label: 'Focus', family: 'custom', interfaceMode: 'example.focus',
      tokens: { msgStyle: 'bubble', inputVariant: 'composer' },
    }))
    const modeRegistration = getInterfaceModeRegistry().register(owner, {
      id: 'example.focus', label: 'Focus Mode', description: 'Plugin-owned complete workbench',
      icon: 'focus', order: 300, defaultPresentationProfileId: 'example.presentation.focus',
      quickSwitchTargetId: 'modern-gui', chromeStyle: 'icons',
      workbench: { renderKind: 'isolated-surface', surfaceId: 'example.focus.workbench' },
    })
    registrations.push(modeRegistration)

    render(<InterfaceModePicker />)
    fireEvent.click(screen.getByRole('radio', { name: /Focus Mode/ }))
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('example.focus')
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('example.presentation.focus')

    const view = render(<AgentSheetView sheet={sheet} ctx={ctx} />)
    await waitFor(() => expect(screen.getByText('FOCUS WORKBENCH')).toBeTruthy())
    expect(view.container.querySelector('[data-plugin-ui-surface="example.focus.workbench"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByTestId('focus-input').textContent).toContain('"modeId":"example.focus"'))
    expect(screen.getByTestId('focus-input').textContent).toContain('"activeSessionId":"session-1"')

    view.unmount()
    await modeRegistration.dispose()
    expect(ensureInterfaceModeProfile()).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
  })

  it('缺少声明的 Surface 时拒绝激活，不污染当前模式', () => {
    const owner = createPluginIdentity('example.broken-mode', 'integration')
    registrations.push(getPresentationProfileRegistry().register(owner, {
      id: 'example.presentation.broken', label: 'Broken', family: 'custom', interfaceMode: 'example.broken-mode', tokens: {},
    }))
    registrations.push(getInterfaceModeRegistry().register(owner, {
      id: 'example.broken-mode', label: 'Broken', defaultPresentationProfileId: 'example.presentation.broken',
      chromeStyle: 'icons', workbench: { renderKind: 'isolated-surface', surfaceId: 'example.missing' },
    }))
    expect(activateInterfaceMode('example.broken-mode')).toBe(false)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
  })
})
