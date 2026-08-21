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

export function activateInterfaceMode(mode: InterfaceMode): boolean {
  const modeContribution = resolveInterfaceMode(mode)
  if (!modeContribution || !interfaceModeIsUsable(modeContribution)) return false
  try {
    const services = {
      suites: getRendererRegistry().snapshot().rendererSuites.map(entry => entry.value),
      modes: getInterfaceModeRegistry().getSnapshot().entries.map(entry => entry.value),
      profiles: getPresentationProfileRegistry().getSnapshot().entries.map(entry => entry.value),
    }
    validateRendererSuiteReferences(services)
  } catch {
    // Invalid cross-registry references make this activation unavailable;
    // persisted preferences remain untouched for a later plugin reload.
    return false
  }
  const state = useInterfaceModeStore.getState()
  if (modeContribution.workbench.renderKind === 'renderer-suite') {
    // Suite activation is resolved by the Suite Host. Keep this transaction
    // side-effect free when the catalog is still loading or a preference is
    // unavailable; the persisted id remains recoverable for plugin reload.
    const selectedSuiteId = usePresentationPreferenceStore.getState().rendererSuiteIdByMode[mode]
    resolveInterfaceModeSuite(modeContribution, selectedSuiteId, getRendererRegistry().snapshot().rendererSuites.map(entry => entry.value.id))
  }
  const profileId = state.profileByMode[mode] || modeContribution.defaultPresentationProfileId
  const registry = getPresentationProfileRegistry()
  const profile = registry.resolve(profileId)?.value
    ?? registry.getSnapshot().entries.find(entry => presentationProfileInterfaceMode(entry.value) === mode)?.value
  if (!profile) return false
  applyModeProfile(mode, profile)
  state.setInterfaceMode(mode)
  return true
}

/** Cold-start/HMR guard: active profile must belong to the persisted Interface Mode. */
export function ensureInterfaceModeProfile(): boolean {
  const mode = useInterfaceModeStore.getState().interfaceMode
  const modeContribution = resolveInterfaceMode(mode)
  if (!modeContribution || !interfaceModeIsUsable(modeContribution)) {
    return mode === DEFAULT_INTERFACE_MODE ? false : activateInterfaceMode(DEFAULT_INTERFACE_MODE)
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
