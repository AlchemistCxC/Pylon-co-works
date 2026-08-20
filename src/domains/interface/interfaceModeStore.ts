import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type InterfaceMode = string

export const DEFAULT_INTERFACE_MODE: InterfaceMode = 'modern-gui'
export const DEFAULT_INTERFACE_PROFILES: Readonly<Record<string, string>> = Object.freeze({
  'modern-gui': 'builtin.presentation.modern-gui',
  'terminal-like': 'builtin.presentation.terminal-classic',
})

interface InterfaceModeState {
  interfaceMode: InterfaceMode
  profileByMode: Record<string, string>
  setInterfaceMode(mode: InterfaceMode): void
  rememberProfile(mode: InterfaceMode, profileId: string): void
}

function validMode(value: unknown): value is InterfaceMode {
  return typeof value === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)
}

export const useInterfaceModeStore = create<InterfaceModeState>()(persist(
  set => ({
    interfaceMode: DEFAULT_INTERFACE_MODE,
    profileByMode: { ...DEFAULT_INTERFACE_PROFILES },
    setInterfaceMode: mode => set({ interfaceMode: validMode(mode) ? mode : DEFAULT_INTERFACE_MODE }),
    rememberProfile: (mode, profileId) => set(state => ({
      profileByMode: {
        ...state.profileByMode,
        [mode]: profileId || state.profileByMode[mode] || DEFAULT_INTERFACE_PROFILES[mode] || '',
      },
    })),
  }),
  {
    name: 'pylon-interface-mode',
    version: 2,
    storage: createJSONStorage(() => localStorage),
    migrate: persisted => {
      const state = persisted as Partial<InterfaceModeState>
      const interfaceMode = validMode(state.interfaceMode) ? state.interfaceMode : DEFAULT_INTERFACE_MODE
      return {
        ...state,
        interfaceMode,
        profileByMode: Object.fromEntries(Object.entries({
          ...DEFAULT_INTERFACE_PROFILES,
          ...(state.profileByMode ?? {}),
        }).filter(([mode, profileId]) => validMode(mode) && typeof profileId === 'string')),
      }
    },
    partialize: state => ({ interfaceMode: state.interfaceMode, profileByMode: state.profileByMode }),
  },
))
