import { beforeEach, describe, expect, it } from 'vitest'
import { migratePresentationPreferences } from '../presentationPreferenceStore.ts'
import { usePresentationPreferenceStore } from '../presentationPreferenceStore.ts'

beforeEach(() => usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true))

describe('presentation preference migration', () => {
  it('migrates v2 message renderer to a per-mode Suite selection', () => {
    expect(migratePresentationPreferences({
      activeProfileId: 'builtin.presentation.terminal-classic',
      messageRendererId: 'core.renderer.react',
    }, 2)).toMatchObject({
      rendererSuiteIdByMode: {
        'modern-gui': 'builtin.solid',
        'terminal-like': 'builtin.solid',
      },
    })
  })

  it('keeps an unknown renderer id as an unavailable Suite preference', () => {
    expect(migratePresentationPreferences({ messageRendererId: 'plugin.missing.renderer' }, 2))
      .toMatchObject({ rendererSuiteIdByMode: {
        'modern-gui': 'plugin.missing.renderer',
        'terminal-like': 'plugin.missing.renderer',
      } })
  })

  it('stores Suite choices independently for each mode', () => {
    const migrated = migratePresentationPreferences({
      rendererSuiteIdByMode: { 'modern-gui': 'suite.gui' },
    }, 3)
    expect(migrated.rendererSuiteIdByMode).toEqual({ 'modern-gui': 'suite.gui' })
    usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'suite.gui')
    usePresentationPreferenceStore.getState().setRendererSuiteId('terminal-like', 'suite.terminal')
    expect(usePresentationPreferenceStore.getState().rendererSuiteIdByMode).toEqual({
      'modern-gui': 'suite.gui', 'terminal-like': 'suite.terminal',
    })
  })
})
