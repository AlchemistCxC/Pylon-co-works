import { attachSolidPersist, createSolidStoreKernel, resolveLocalStorage } from '../../infrastructure/state/solidStoreKernel'
import { createReactStoreHook, type ZustandHook } from '../../infrastructure/state/reactStoreShim'

export type InterfaceMode = string

export const DEFAULT_INTERFACE_MODE: InterfaceMode = 'modern-gui'
export const DEFAULT_INTERFACE_PROFILES: Readonly<Record<string, string>> = Object.freeze({
  'tactical-blue': 'builtin.presentation.tactical-blue',
  'modern-gui': 'builtin.presentation.modern-gui',
  'terminal-like': 'builtin.presentation.terminal-classic',
})

interface InterfaceModeState {
  interfaceMode: InterfaceMode
  profileByMode: Record<string, string>
  setInterfaceMode(mode: InterfaceMode): void
  rememberProfile(mode: InterfaceMode, profileId: string): void
  /** A17：注销插件 mode 后清掉悬挂的 per-mode profile 偏好。 */
  forgetModeProfile(mode: InterfaceMode): void
}

function validMode(value: unknown): value is InterfaceMode {
  return typeof value === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)
}

// #515 批0：zustand → Solid 内核置换（对外签名不变；hook shim 待 React 面退役时拆除）。
const kernel = createSolidStoreKernel<InterfaceModeState>({
  interfaceMode: DEFAULT_INTERFACE_MODE,
  profileByMode: { ...DEFAULT_INTERFACE_PROFILES },
  setInterfaceMode: mode => kernel.setState({ interfaceMode: validMode(mode) ? mode : DEFAULT_INTERFACE_MODE }),
  rememberProfile: (mode, profileId) => kernel.setState(state => ({
    profileByMode: {
      ...state.profileByMode,
      [mode]: profileId || state.profileByMode[mode] || DEFAULT_INTERFACE_PROFILES[mode] || '',
    },
  })),
  forgetModeProfile: mode => kernel.setState(state => {
    if (!(mode in state.profileByMode)) return state
    const next = { ...state.profileByMode }
    delete next[mode]
    return { profileByMode: next }
  }),
})

attachSolidPersist(kernel, {
  name: 'pylon-interface-mode',
  version: 2,
  storage: resolveLocalStorage(),
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
})

export const useInterfaceModeStore: ZustandHook<InterfaceModeState> = createReactStoreHook(kernel)
