import type { RegistryEntry } from '../registry/types.ts'

/** The UI role controls where a contributed font may be selected. */
export type FontRole = 'interface' | 'content' | 'code'

/**
 * Plugins contribute a stable font id and a CSS font-family stack. Loading a
 * bundled @font-face remains the plugin's responsibility, so the host never
 * downloads an untrusted remote asset on behalf of a contribution.
 */
export interface FontContribution {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly family: string
  readonly roles: readonly FontRole[]
  readonly order?: number
  readonly sample?: string
}

export type FontContributionRegistryEntry = RegistryEntry<FontContribution>

