// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateInterfaceMode, presentationProfileInterfaceMode } from '../../../application/transactions/activateInterfaceMode.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { getInterfaceModeRegistry, getPresentationProfileRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { usePresentationPreferenceStore } from '../../presentation/presentationPreferenceStore.ts'
import { useStore } from '../../../store.ts'
import { DEFAULT_INTERFACE_MODE, DEFAULT_INTERFACE_PROFILES, useInterfaceModeStore } from '../interfaceModeStore.ts'

const registrations: AsyncDisposable[] = []

beforeEach(() => {
  localStorage.clear()
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
  usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)
})

afterEach(async () => {
  while (registrations.length > 0) await registrations.pop()?.dispose()
})

describe('Interface Mode contract', () => {
  it('默认为 modern-gui，两种模式分别记忆 Presentation Profile', () => {
    expect(useInterfaceModeStore.getState().interfaceMode).toBe(DEFAULT_INTERFACE_MODE)
    expect(useInterfaceModeStore.getState().profileByMode).toEqual(DEFAULT_INTERFACE_PROFILES)
    useInterfaceModeStore.getState().rememberProfile('terminal-like', 'terminal.custom')
    expect(useInterfaceModeStore.getState().profileByMode['modern-gui']).toBe('builtin.presentation.modern-gui')
    expect(useInterfaceModeStore.getState().profileByMode['terminal-like']).toBe('terminal.custom')
  })

  it('遗留 Profile 默认归 terminal-like，显式元数据可归 modern-gui', () => {
    expect(presentationProfileInterfaceMode({ id: 'legacy', label: 'Legacy', family: 'terminal', tokens: {} })).toBe('terminal-like')
    expect(presentationProfileInterfaceMode({ id: 'modern', label: 'Modern', family: 'gui', interfaceMode: 'modern-gui', tokens: {} })).toBe('modern-gui')
  })

  it('切换模式时原子应用该模式记忆的 Profile，不卸载应用', () => {
    const registry = getPresentationProfileRegistry()
    const owner = createPluginIdentity('test.interface', 'one')
    registrations.push(registry.register(owner, {
      id: 'builtin.presentation.modern-gui', label: 'Modern', family: 'gui', interfaceMode: 'modern-gui',
      tokens: { msgStyle: 'bubble', inputVariant: 'composer' },
    }))
    registrations.push(registry.register(owner, {
      id: 'builtin.presentation.terminal-classic', label: 'Classic', family: 'terminal',
      tokens: { msgStyle: 'terminal', inputVariant: 'cli' },
    }))
    const modes = getInterfaceModeRegistry()
    registrations.push(modes.register(owner, {
      id: 'modern-gui', label: 'Modern GUI', defaultPresentationProfileId: 'builtin.presentation.modern-gui',
      chromeStyle: 'icons', workbench: { renderKind: 'host', renderer: 'modern' },
    }))
    registrations.push(modes.register(owner, {
      id: 'terminal-like', label: 'Terminal-like', defaultPresentationProfileId: 'builtin.presentation.terminal-classic',
      chromeStyle: 'glyphs', workbench: { renderKind: 'host', renderer: 'terminal' },
    }))

    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('terminal-like')
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.terminal-classic')
    expect(useStore.getState()).toMatchObject({ msgStyle: 'terminal', inputVariant: 'cli' })

    expect(activateInterfaceMode('modern-gui')).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.modern-gui')
    expect(useStore.getState()).toMatchObject({ msgStyle: 'bubble', inputVariant: 'composer' })
  })
})
