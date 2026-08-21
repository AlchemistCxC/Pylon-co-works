import type { InterfaceModeContribution } from '../interface-mode/interfaceModeTypes.ts'
import type { PresentationProfileContribution } from '../presentation/presentationProfileTypes.ts'
import type { RendererSuiteContribution } from './rendererSuiteTypes.ts'

export interface RendererSuiteReferenceGraph {
  readonly suites: readonly RendererSuiteContribution[]
  readonly modes: readonly InterfaceModeContribution[]
  readonly profiles: readonly PresentationProfileContribution[]
}

/**
 * Cross-registry reference validation kept pure so registries remain
 * authoritative and do not import one another. Callers pass immutable
 * candidate snapshots at activation/transaction seams.
 */
export function validateRendererSuiteReferences(graph: RendererSuiteReferenceGraph): void {
  const suites = new Set(graph.suites.map(suite => suite.id))
  const modes = new Set(graph.modes.map(mode => mode.id))
  const profiles = new Set(graph.profiles.map(profile => profile.id))

  for (const mode of graph.modes) {
    if (!profiles.has(mode.defaultPresentationProfileId)) {
      throw new Error(`Interface Mode 引用未知 Presentation Profile：${mode.id} -> ${mode.defaultPresentationProfileId}`)
    }
    if (mode.workbench.renderKind === 'renderer-suite' && !suites.has(mode.workbench.defaultSuiteId)) {
      throw new Error(`Interface Mode 引用未知 Renderer Suite：${mode.id} -> ${mode.workbench.defaultSuiteId}`)
    }
    if (mode.quickSwitchTargetId !== undefined && !modes.has(mode.quickSwitchTargetId)) {
      throw new Error(`Interface Mode quickSwitchTargetId 未注册：${mode.id} -> ${mode.quickSwitchTargetId}`)
    }
  }

  for (const profile of graph.profiles) {
    if (profile.interfaceMode !== undefined && !modes.has(profile.interfaceMode)) {
      throw new Error(`Presentation Profile 引用未知 Interface Mode：${profile.id} -> ${profile.interfaceMode}`)
    }
  }
}
