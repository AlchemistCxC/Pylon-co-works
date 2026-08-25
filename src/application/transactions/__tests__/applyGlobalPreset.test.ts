// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { getInterfaceModeRegistry, getPresentationProfileRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { useInterfaceModeStore } from '../../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../../domains/presentation/presentationPreferenceStore.ts'
import { useStore } from '../../../store.ts'
import { applyGlobalPreset } from '../applyGlobalPreset.ts'

const registrations: AsyncDisposable[] = []

beforeEach(() => {
  localStorage.clear()
  useStore.setState(useStore.getInitialState(), true)
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
  usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)

  const owner = createPluginIdentity('test.global-preset', 'one')
  const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === 'builtin.presentation.agent-command')
  if (!profile) throw new Error('missing Agent command profile fixture')
  registrations.push(getPresentationProfileRegistry().register(owner, profile))
  registrations.push(getInterfaceModeRegistry().register(owner, {
    id: 'modern-gui',
    label: 'Modern GUI',
    defaultPresentationProfileId: 'builtin.presentation.agent-command',
    chromeStyle: 'icons',
    workbench: { renderKind: 'host', renderer: 'modern' },
  }))
})

afterEach(async () => {
  while (registrations.length > 0) await registrations.pop()?.dispose()
})

describe('applyGlobalPreset', () => {
  it('一次应用 Agent 全局预设会同步主题、Solid 呈现方案与界面模式', () => {
    expect(applyGlobalPreset('agent-command')).toBe(true)

    expect(useStore.getState()).toMatchObject({
      accent: '#38bdf8',
      globalBgColor: '#08111f',
      msgStyle: 'bubble',
      inputVariant: 'composer',
      appliedPreset: {
        global: 'agent-command', sidebar: 'agent-command', chat: 'agent-command',
        cc: 'agent-command', right: 'agent-command',
      },
      custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
    })
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.agent-command')
    expect(useInterfaceModeStore.getState()).toMatchObject({
      interfaceMode: 'modern-gui',
      profileByMode: { 'modern-gui': 'builtin.presentation.agent-command' },
    })
  })
})
