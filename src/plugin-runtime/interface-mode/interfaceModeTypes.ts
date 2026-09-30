import type { RegistryEntry } from '../registry/types.ts'

export type InterfaceModeChromeStyle = 'icons' | 'glyphs'

export type InterfaceModeWorkbench =
  | { readonly renderKind: 'renderer-suite'; readonly defaultSuiteId: string }
  | { readonly renderKind: 'host'; readonly renderer: 'modern' | 'terminal' }
  | { readonly renderKind: 'isolated-surface'; readonly surfaceId: string }

export interface InterfaceModeShellSurface {
  readonly surfaceId: string
  readonly placement: 'before-workspace' | 'overlay'
}

/**
 * Decorative scene plane declaration (A-V9). The host resolves surfaceId in the
 * view-side builtin scene registry and mounts the scene component; declaring a
 * scene surface is the only way any mode — builtin or plugin-contributed — gets
 * a decoration plane, no mode-id special-casing in the shell.
 */
export interface InterfaceModeSceneSurface {
  readonly surfaceId: string
}

/**
 * Host-consumed mode capability keys. Values are declared in
 * `InterfaceModeContribution.capabilities`; the shell renders the matching
 * builtin surface instead of special-casing mode ids.
 */
export const INTERFACE_MODE_CAPABILITY_OVERVIEW_DECK = 'overview.command-deck'

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
  readonly sceneSurface?: InterfaceModeSceneSurface
  /** Optional Shell arrangement recipe (ADR-0003); unregistered ids fail activation. */
  readonly shellRecipeId?: string
  readonly capabilities?: Readonly<Record<string, boolean>>
}

export type InterfaceModeRegistryEntry = RegistryEntry<InterfaceModeContribution>
