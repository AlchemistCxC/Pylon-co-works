// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../../../store.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { useInterfaceModeStore } from '../../interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../presentation/presentationPreferenceStore.ts'
import { getInterfaceModeRegistry, getPresentationProfileRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { BUILTIN_INTERFACE_MODES } from '../../../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { activateInterfaceMode, activatePresentationProfile } from '../../../application/transactions/activateInterfaceMode.ts'

describe('custom preset overwrite', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('keeps the selected target after interface/profile transitions and updates only it', async () => {
    const owner = createPluginIdentity(`test.custom-overwrite.${Date.now()}`, '1')
    // The production bootstrap registers these contributions through the
    // plugin host. Register host-compatible fixtures here so the transaction
    // path exercised by the regression is the same one used by the UI.
    const profileRegs = BUILTIN_PRESENTATION_PROFILES.map(profile =>
      getPresentationProfileRegistry().register(owner, profile),
    )
    const modeRegs = BUILTIN_INTERFACE_MODES.map(mode =>
      getInterfaceModeRegistry().register(owner, {
        ...mode,
        workbench: {
          renderKind: 'host',
          renderer: mode.id === 'modern-gui' ? 'modern' : 'terminal',
        },
      }),
    )

    try {
      useStore.getState().setZoneField('chat', { chatFontSize: 17 })
      const firstId = useStore.getState().saveCustomPreset('first')
      useStore.getState().setZoneField('chat', { chatFontSize: 19 })
      const secondId = useStore.getState().saveCustomPreset('second')
      const firstCreatedAt = useStore.getState().customPresets.find(item => item.id === firstId)?.createdAt

      for (const [mode, profileId] of [
        ['terminal-like', 'builtin.presentation.terminal-classic'],
        ['terminal-like', 'builtin.presentation.terminal-modern'],
        ['modern-gui', 'builtin.presentation.modern-gui'],
        ['modern-gui', 'builtin.presentation.agent-command'],
        ['modern-gui', 'builtin.presentation.agent-map'],
      ] as const) {
        expect(activateInterfaceMode(mode)).toBe(true)
        expect(activatePresentationProfile(profileId)).toBe(true)
      }

      useStore.getState().setZoneField('chat', { chatFontSize: 31 })
      expect(useStore.getState().saveCustomPreset('first', firstId)).toBe(firstId)

      const presets = useStore.getState().customPresets
      expect(presets).toHaveLength(2)
      expect(presets.find(item => item.id === firstId)?.theme.chatFontSize).toBe(31)
      expect(presets.find(item => item.id === secondId)?.theme.chatFontSize).toBe(19)
      expect(presets.find(item => item.id === firstId)?.createdAt).toBe(firstCreatedAt)
      expect(presets.find(item => item.id === firstId)?.bundle?.id).toBe(firstId)
    } finally {
      for (const registration of [...modeRegs, ...profileRegs]) await registration.dispose()
    }
  })

  it('reports a stale explicit overwrite id instead of silently creating another preset', () => {
    expect(() => useStore.getState().saveCustomPreset('stale', 'custom-does-not-exist'))
      .toThrow('要覆盖的自定义预设不存在')
    expect(useStore.getState().customPresets).toHaveLength(0)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBeTruthy()
  })
})
