import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const DEFAULT_PRESENTATION_PROFILE_ID = 'builtin.presentation.terminal-classic'

interface PresentationPreferenceState {
  activeProfileId: string
  /** User-selected Renderer Suite per Interface Mode. Unknown ids are retained for recovery. */
  rendererSuiteIdByMode: Record<string, string>
  setActiveProfileId(id: string): void
  setRendererSuiteId(mode: string, suiteId: string): void
}

type LegacyPresentationPreferences = { activeProfileId?: string; messageRendererId?: string }
export type PersistedPresentationPreferences = Partial<Pick<PresentationPreferenceState, 'activeProfileId' | 'rendererSuiteIdByMode'>> & LegacyPresentationPreferences

const PRESENTATION_MODE_IDS = ['modern-gui', 'terminal-like'] as const
const LEGACY_RENDERER_TO_SUITE: Readonly<Record<string, string>> = Object.freeze({
  'core.renderer.react': 'builtin.solid',
  'core.renderer.solid': 'builtin.solid',
})

/**
 * v2 stored a single message renderer. Preserve that choice as a Suite choice
 * for every built-in mode; ids we do not recognise remain visible as
 * unavailable preferences instead of being silently replaced.
 */
export function migratePresentationPreferences(
  persisted: unknown,
  version: number,
): PersistedPresentationPreferences {
  const state = persisted && typeof persisted === 'object'
    ? persisted as PersistedPresentationPreferences
    : {}
  if (version >= 3) {
    return {
      ...state,
      ...(state.rendererSuiteIdByMode ? { rendererSuiteIdByMode: { ...state.rendererSuiteIdByMode } } : {}),
    }
  }
  const legacyRendererId = typeof state.messageRendererId === 'string' && state.messageRendererId.trim() && state.messageRendererId !== 'auto'
    ? state.messageRendererId.trim()
    : undefined
  const migratedSuiteId = legacyRendererId ? LEGACY_RENDERER_TO_SUITE[legacyRendererId] ?? legacyRendererId : undefined
  return {
    ...state,
    ...(migratedSuiteId ? {
      rendererSuiteIdByMode: Object.fromEntries(PRESENTATION_MODE_IDS.map(mode => [mode, migratedSuiteId])),
    } : {}),
  }
}

export const usePresentationPreferenceStore = create<PresentationPreferenceState>()(persist(
  set => ({
    activeProfileId: DEFAULT_PRESENTATION_PROFILE_ID,
    rendererSuiteIdByMode: {},
    setActiveProfileId: id => set({ activeProfileId: id || DEFAULT_PRESENTATION_PROFILE_ID }),
    setRendererSuiteId: (mode, suiteId) => {
      if (!mode.trim() || !suiteId.trim()) return
      set(state => ({ rendererSuiteIdByMode: { ...state.rendererSuiteIdByMode, [mode]: suiteId } }))
    },
  }),
  {
    name: 'pylon-presentation-preferences',
    version: 3,
    storage: createJSONStorage(() => localStorage),
    migrate: (persisted, version) => {
      const state = migratePresentationPreferences(persisted, version) as Partial<PresentationPreferenceState>
      const aliases: Record<string, string> = {
        'builtin.presentation.terminal-focus': 'builtin.presentation.terminal-modern',
        'builtin.presentation.terminal-transcript': 'builtin.presentation.paper-low-contrast',
        'builtin.presentation.hybrid-workbench': 'builtin.presentation.console-glass',
      }
      return { ...state, activeProfileId: aliases[state.activeProfileId ?? ''] ?? state.activeProfileId ?? DEFAULT_PRESENTATION_PROFILE_ID }
    },
    partialize: state => ({
      activeProfileId: state.activeProfileId,
      rendererSuiteIdByMode: state.rendererSuiteIdByMode,
    }),
  },
))
