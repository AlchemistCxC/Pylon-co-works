import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const DEFAULT_PRESENTATION_PROFILE_ID = 'builtin.presentation.terminal-classic'

interface PresentationPreferenceState {
  activeProfileId: string
  messageRendererId: string
  setActiveProfileId(id: string): void
  setMessageRendererId(id: string): void
}

export const usePresentationPreferenceStore = create<PresentationPreferenceState>()(persist(
  set => ({
    activeProfileId: DEFAULT_PRESENTATION_PROFILE_ID,
    messageRendererId: 'auto',
    setActiveProfileId: id => set({ activeProfileId: id || DEFAULT_PRESENTATION_PROFILE_ID }),
    setMessageRendererId: id => set({ messageRendererId: id || 'auto' }),
  }),
  {
    name: 'pylon-presentation-preferences',
    version: 2,
    storage: createJSONStorage(() => localStorage),
    migrate: persisted => {
      const state = persisted as Partial<PresentationPreferenceState>
      const aliases: Record<string, string> = {
        'builtin.presentation.terminal-focus': 'builtin.presentation.terminal-modern',
        'builtin.presentation.terminal-transcript': 'builtin.presentation.paper-low-contrast',
        'builtin.presentation.hybrid-workbench': 'builtin.presentation.console-glass',
      }
      return { ...state, activeProfileId: aliases[state.activeProfileId ?? ''] ?? state.activeProfileId ?? DEFAULT_PRESENTATION_PROFILE_ID }
    },
    partialize: state => ({
      activeProfileId: state.activeProfileId,
      messageRendererId: state.messageRendererId,
    }),
  },
))
