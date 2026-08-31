import type { ComponentType, LazyExoticComponent } from 'react'
import type { RegistryEntry } from '../registry/types.ts'

/** Slots owned by the application shell. Plugins may contribute to these slots,
 * but never replace native window controls or the drag-region boundary. */
export type TitlebarSlot = 'left-rail' | 'workspace' | 'center' | 'app-actions'

export interface TitlebarContext {
  readonly interfaceMode: string
  readonly workspaceKind?: string
  readonly sheetId: string | null
  readonly settingsOpen: boolean
}

interface TitlebarContributionBase {
  readonly id: string
  readonly slot: TitlebarSlot
  readonly label: string
  readonly order?: number
  readonly when?: (context: TitlebarContext) => boolean
  readonly commandId?: string
  readonly widthBehavior?: 'fixed' | 'shrink' | 'overflow-menu'
}

export interface FirstPartyTitlebarContribution extends TitlebarContributionBase {
  readonly renderKind: 'first-party-react'
  readonly component: ComponentType<{ context: TitlebarContext }> | LazyExoticComponent<ComponentType<{ context: TitlebarContext }>>
}

export interface IsolatedTitlebarContribution extends TitlebarContributionBase {
  readonly renderKind: 'isolated-surface'
  readonly surfaceId: string
}

export type TitlebarContribution = FirstPartyTitlebarContribution | IsolatedTitlebarContribution
export type TitlebarRegistryEntry = RegistryEntry<TitlebarContribution>
