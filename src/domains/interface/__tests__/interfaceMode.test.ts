// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateInterfaceMode, presentationProfileInterfaceMode, resetThemeForActiveInterfaceMode, resolveInterfaceModeSuite } from '../../../application/transactions/activateInterfaceMode.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { getInterfaceModeRegistry, getPresentationProfileRegistry, getRendererRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { usePresentationPreferenceStore } from '../../presentation/presentationPreferenceStore.ts'
import { useStore } from '../../../store.ts'
import { DEFAULT_INTERFACE_MODE, DEFAULT_INTERFACE_PROFILES, useInterfaceModeStore } from '../interfaceModeStore.ts'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { BUILTIN_INTERFACE_MODES } from '../../../plugins/core/interfaceMode/builtinInterfaceModes.ts'

const registrations: AsyncDisposable[] = []

const CC_INPUT_TOKEN_KEYS = [
  'inputMode', 'inputVariant', 'inputBg', 'inputBorderColor', 'inputFocusBorder',
  'inputRadius', 'inputFocusRingWidth', 'ccVariant', 'cliHintMode', 'footerLayout',
] as const

function resetAppearanceState(): void {
  useStore.setState(useStore.getInitialState(), true)
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
  usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)
}

function appearanceSnapshot(): Record<string, unknown> {
  const theme = useStore.getState()
  return {
    interfaceMode: useInterfaceModeStore.getState().interfaceMode,
    activeProfileId: usePresentationPreferenceStore.getState().activeProfileId,
    ...Object.fromEntries(CC_INPUT_TOKEN_KEYS.map(key => [key, theme[key]])),
  }
}

function registerBuiltinAppearanceContributions(): void {
  const owner = createPluginIdentity('test.interface.builtins', 'one')
  const profiles = getPresentationProfileRegistry()
  const modes = getInterfaceModeRegistry()
  const renderers = getRendererRegistry()
  registrations.push(renderers.registerSuite(owner, {
    id: 'builtin.solid', label: 'Test Solid Suite', apiVersion: 1,
    runtime: { framework: 'solid', version: '1.0.0' },
    compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
    requiredKinds: ['content.unknown'],
    factory: () => ({}),
  }))
  for (const profile of BUILTIN_PRESENTATION_PROFILES) registrations.push(profiles.register(owner, profile))
  for (const mode of BUILTIN_INTERFACE_MODES) registrations.push(modes.register(owner, mode))
}

beforeEach(() => {
  localStorage.clear()
  resetAppearanceState()
})

afterEach(async () => {
  while (registrations.length > 0) await registrations.pop()?.dispose()
})

describe('Interface Mode contract', () => {
  it('resolves mode default < per-mode preference and reports unavailable without overwriting it', () => {
    const mode = {
      id: 'modern-gui', label: 'Modern', defaultPresentationProfileId: 'p', chromeStyle: 'icons' as const,
      workbench: { renderKind: 'renderer-suite' as const, defaultSuiteId: 'suite.mode' },
    }
    expect(resolveInterfaceModeSuite(mode, 'suite.user', ['suite.user'])).toMatchObject({
      requestedSuiteId: 'suite.user', activeSuiteId: 'suite.user', unavailable: false,
    })
    expect(resolveInterfaceModeSuite(mode, 'suite.missing', ['builtin.solid'])).toMatchObject({
      requestedSuiteId: 'suite.missing', activeSuiteId: 'builtin.solid', unavailable: true,
    })
  })

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

  it('四条重置/切换路径回到 Modern 后得到同一套中控与输入 token', () => {
    registerBuiltinAppearanceContributions()

    resetAppearanceState()
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    const resetThenModern = appearanceSnapshot()

    resetAppearanceState()
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    const terminalThenModern = appearanceSnapshot()

    resetAppearanceState()
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    const terminalResetThenModern = appearanceSnapshot()

    resetAppearanceState()
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    const terminalModernThenReset = appearanceSnapshot()

    expect(resetThenModern).toMatchObject({
      interfaceMode: 'modern-gui',
      activeProfileId: 'builtin.presentation.modern-gui',
    })
    expect(terminalThenModern).toEqual(resetThenModern)
    expect(terminalResetThenModern).toEqual(resetThenModern)
    expect(terminalModernThenReset).toEqual(resetThenModern)
  })
})
