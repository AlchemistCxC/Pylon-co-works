import type { RegistryEntry } from '../registry/types.ts'

export type InterfaceModeChromeStyle = 'icons' | 'glyphs'

export type InterfaceModeWorkbench =
  | { readonly renderKind: 'host'; readonly renderer: 'modern' | 'terminal' }
  | { readonly renderKind: 'isolated-surface'; readonly surfaceId: string }

export interface InterfaceModeShellSurface {
  readonly surfaceId: string
  readonly placement: 'before-workspace' | 'overlay'
}

/**
 * Complete application-level mode descriptor. Kernel, persistence, Sheet
 * lifecycle and dialogs remain host-owned; the mode selects structured Shell
 * semantics and the Agent workbench implementation.
 */
export interface InterfaceModeContribution {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly order?: number
  readonly icon?: string
  readonly defaultPresentationProfileId: string
  readonly quickSwitchTargetId?: string
  readonly chromeStyle: InterfaceModeChromeStyle
  readonly workbench: InterfaceModeWorkbench
  readonly shellSurface?: InterfaceModeShellSurface
}

export type InterfaceModeRegistryEntry = RegistryEntry<InterfaceModeContribution>

