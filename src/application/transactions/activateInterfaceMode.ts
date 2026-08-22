import { applyPresentationProfile } from './applyPresentationProfile.ts'
import { DEFAULT_INTERFACE_MODE, type InterfaceMode, useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getInterfaceModeRegistry, getPluginUiRegistry, getPresentationProfileRegistry, getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'
import type { PresentationProfileContribution } from '../../plugin-runtime/presentation/presentationProfileTypes.ts'
import type { InterfaceModeContribution } from '../../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { useStore } from '../../store.ts'
import { validateRendererSuiteReferences } from '../../plugin-runtime/renderers/rendererSuiteReferences.ts'

export interface InterfaceModeSuiteChoice {
  readonly requestedSuiteId?: string
  readonly activeSuiteId?: string
  readonly unavailable: boolean
}

/** Resolve Suite precedence without mutating the persisted preference. */
export function resolveInterfaceModeSuite(
  mode: InterfaceModeContribution,
  selectedSuiteId: string | undefined,
  availableSuiteIds: readonly string[],
  fallbackSuiteId = 'builtin.solid',
): InterfaceModeSuiteChoice {
  if (mode.workbench.renderKind !== 'renderer-suite') return { unavailable: false }
  const requestedSuiteId = selectedSuiteId || mode.workbench.defaultSuiteId
  const available = new Set(availableSuiteIds)
  if (available.has(requestedSuiteId)) return { requestedSuiteId, activeSuiteId: requestedSuiteId, unavailable: false }
  const activeSuiteId = available.has(fallbackSuiteId) ? fallbackSuiteId : availableSuiteIds[0]
  return { requestedSuiteId, activeSuiteId, unavailable: true }
}

export function presentationProfileInterfaceMode(profile: PresentationProfileContribution): InterfaceMode {
  return profile.interfaceMode ?? 'terminal-like'
}

export function resolveInterfaceMode(mode: InterfaceMode): InterfaceModeContribution | undefined {
  return getInterfaceModeRegistry().resolve(mode)?.value
}

export function interfaceModeIsUsable(mode: InterfaceModeContribution): boolean {
  const ui = getPluginUiRegistry()
  if (mode.workbench.renderKind === 'isolated-surface' && !ui.resolve(mode.workbench.surfaceId)) return false
  if (mode.shellSurface && !ui.resolve(mode.shellSurface.surfaceId)) return false
  return true
}

function applyModeProfile(mode: InterfaceMode, profile: PresentationProfileContribution): void {
  applyPresentationProfile(profile, {
    setZoneField: (zone, patch) => useStore.getState().setZoneField(zone, patch),
    setActiveProfileId: profileId => usePresentationPreferenceStore.getState().setActiveProfileId(profileId),
  })
  useInterfaceModeStore.getState().rememberProfile(mode, profile.id)
}

function resolveActivatableMode(mode: InterfaceMode): InterfaceModeContribution | undefined {
  const modeContribution = resolveInterfaceMode(mode)
  if (!modeContribution || !interfaceModeIsUsable(modeContribution)) return undefined
  try {
    const services = {
      suites: getRendererRegistry().snapshot().rendererSuites.map(entry => entry.value),
      modes: getInterfaceModeRegistry().getSnapshot().entries.map(entry => entry.value),
      profiles: getPresentationProfileRegistry().getSnapshot().entries.map(entry => entry.value),
    }
    validateRendererSuiteReferences(services)
  } catch {
    return undefined
  }
  if (modeContribution.workbench.renderKind === 'renderer-suite') {
    const selectedSuiteId = usePresentationPreferenceStore.getState().rendererSuiteIdByMode[mode]
    resolveInterfaceModeSuite(modeContribution, selectedSuiteId, getRendererRegistry().snapshot().rendererSuites.map(entry => entry.value.id))
  }
  return modeContribution
}

/** 激活一个明确的 Profile；注册表引用未通过校验时保持偏好与主题不变。 */
export function activatePresentationProfile(profileId: string): boolean {
  const profile = getPresentationProfileRegistry().resolve(profileId)?.value
  if (!profile) return false
  const mode = presentationProfileInterfaceMode(profile)
  if (!resolveActivatableMode(mode)) return false
  applyModeProfile(mode, profile)
  useInterfaceModeStore.getState().setInterfaceMode(mode)
  return true
}

export function activateInterfaceMode(mode: InterfaceMode): boolean {
  const modeContribution = resolveActivatableMode(mode)
  if (!modeContribution) return false
  const state = useInterfaceModeStore.getState()
  const profileId = state.profileByMode[mode] || modeContribution.defaultPresentationProfileId
  const registry = getPresentationProfileRegistry()
  const profile = registry.resolve(profileId)?.value
    ?? registry.getSnapshot().entries.find(entry => presentationProfileInterfaceMode(entry.value) === mode)?.value
  if (!profile) return false
  applyModeProfile(mode, profile)
  state.setInterfaceMode(mode)
  return true
}

/** Reset the Theme Store, then restore the current mode's remembered/default Presentation Profile. */
export function resetThemeForActiveInterfaceMode(): boolean {
  const mode = useInterfaceModeStore.getState().interfaceMode
  const modeContribution = resolveActivatableMode(mode)
  if (!modeContribution) return false
  const state = useInterfaceModeStore.getState()
  const profileId = state.profileByMode[mode] || modeContribution.defaultPresentationProfileId
  const registry = getPresentationProfileRegistry()
  const profile = registry.resolve(profileId)?.value
    ?? registry.getSnapshot().entries.find(entry => presentationProfileInterfaceMode(entry.value) === mode)?.value
  if (!profile) return false

  useStore.getState().resetTheme()
  applyModeProfile(mode, profile)
  return true
}

/**
 * 清理指向已注销 Interface Mode 的残留 presentation profile 偏好。
 * 只动偏好存储（可重建态），不触碰 registry——registry 权威归插件生命周期所有。
 */
function pruneDanglingPresentationProfiles(): void {
  const modes = new Set(getInterfaceModeRegistry().getSnapshot().entries.map(entry => entry.value.id))
  const { profileByMode, forgetModeProfile } = useInterfaceModeStore.getState()
  for (const [mode, profileId] of Object.entries(profileByMode)) {
    if (modes.has(mode)) continue
    // per-mode 偏好指向的 profile 若已随插件注销，清掉悬挂映射让 DEFAULT profile 接管
    if (!getPresentationProfileRegistry().resolve(profileId)?.value) forgetModeProfile(mode)
  }
}

/** Cold-start/HMR guard: active profile must belong to the persisted Interface Mode. */
export function ensureInterfaceModeProfile(): boolean {
  const mode = useInterfaceModeStore.getState().interfaceMode
  const modeContribution = resolveInterfaceMode(mode)
  if (!modeContribution || !interfaceModeIsUsable(modeContribution)) {
    if (mode === DEFAULT_INTERFACE_MODE) return false
    // A17 韧性：插件卸载可能留下引用已注销 mode 的残留 presentation profile——
    // validateRendererSuiteReferences 会因此拒绝激活。先清理跨注册表悬挂引用再重试，
    // 保证默认模式回退不被半套注销状态卡死。
    const firstAttempt = activateInterfaceMode(DEFAULT_INTERFACE_MODE)
    if (firstAttempt) return true
    pruneDanglingPresentationProfiles()
    return activateInterfaceMode(DEFAULT_INTERFACE_MODE)
  }
  const activeProfile = getPresentationProfileRegistry().resolve(usePresentationPreferenceStore.getState().activeProfileId)?.value
  if (activeProfile && presentationProfileInterfaceMode(activeProfile) === mode) {
    useInterfaceModeStore.getState().rememberProfile(mode, activeProfile.id)
    return true
  }
  return activateInterfaceMode(mode)
}

export function interfaceModeQuickTarget(mode: InterfaceMode): InterfaceModeContribution | undefined {
  const current = resolveInterfaceMode(mode)
  if (!current?.quickSwitchTargetId) return undefined
  const target = resolveInterfaceMode(current.quickSwitchTargetId)
  return target && interfaceModeIsUsable(target) ? target : undefined
}
