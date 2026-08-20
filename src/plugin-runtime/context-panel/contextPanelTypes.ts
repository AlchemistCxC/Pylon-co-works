import type { ComponentType, LazyExoticComponent } from 'react'
import type { RegistryEntry } from '../registry/types.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'

export interface ContextPanelContributionContext {
  readonly workspaceKind: string
  readonly sheetId: string
  readonly activeSessionId: string | null
}

export interface ContextPanelContributionProps {
  readonly sheet: SheetRecord
  readonly ctx: SheetContext
}

interface ContextPanelContributionBase {
  readonly id: string
  readonly workspaceKind: string
  readonly label: string
  readonly order?: number
  readonly when?: (context: ContextPanelContributionContext) => boolean
}

export interface FirstPartyContextPanelContribution extends ContextPanelContributionBase {
  readonly renderKind: 'first-party-react'
  readonly component: ComponentType<ContextPanelContributionProps> | LazyExoticComponent<ComponentType<ContextPanelContributionProps>>
}

export interface IsolatedContextPanelContribution extends ContextPanelContributionBase {
  readonly renderKind: 'isolated-surface'
  readonly surfaceId: string
}

export type ContextPanelContribution = FirstPartyContextPanelContribution | IsolatedContextPanelContribution
export type ContextPanelRegistryEntry = RegistryEntry<ContextPanelContribution>
