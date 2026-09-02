import type { ComponentType, LazyExoticComponent } from 'react';
import type { RegistryEntry } from '../registry/types.js';
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.js';
export interface ContextPanelContributionContext {
    readonly workspaceKind?: string;
    readonly sheetId: string | null;
    readonly activeSessionId: string | null;
    readonly activeAgent?: string;
}
/** Context supplied by the application shell. A panel may be global (no Sheet)
 * or contextual (filtered by workspaceKind/sheetId). */
export type ShellContext = ContextPanelContributionContext;
export interface ContextPanelSettingsContribution {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    /** Optional canonical Settings section; defaults to the right-rail section. */
    readonly section?: 'right' | 'pluginManager';
    /** Existing PluginSettingsPage contribution to open when selected. */
    readonly pageId?: string;
}
export interface ContextPanelContributionProps {
    readonly sheet: SheetRecord;
    readonly ctx: SheetContext;
}
interface ContextPanelContributionBase {
    readonly id: string;
    readonly workspaceKind?: string;
    readonly label: string;
    readonly icon?: string;
    readonly order?: number;
    readonly scope?: 'global' | 'contextual';
    readonly placement?: 'right-rail' | 'right-dock' | 'overlay';
    readonly minWidth?: number;
    readonly maxWidth?: number;
    readonly defaultWidth?: number;
    readonly settings?: ContextPanelSettingsContribution;
    readonly when?: (context: ContextPanelContributionContext) => boolean;
}
export interface FirstPartyContextPanelContribution extends ContextPanelContributionBase {
    readonly renderKind: 'first-party-react';
    readonly component: ComponentType<ContextPanelContributionProps> | LazyExoticComponent<ComponentType<ContextPanelContributionProps>>;
}
export interface IsolatedContextPanelContribution extends ContextPanelContributionBase {
    readonly renderKind: 'isolated-surface';
    readonly surfaceId: string;
}
export type ContextPanelContribution = FirstPartyContextPanelContribution | IsolatedContextPanelContribution;
export type ContextPanelRegistryEntry = RegistryEntry<ContextPanelContribution>;
export {};
