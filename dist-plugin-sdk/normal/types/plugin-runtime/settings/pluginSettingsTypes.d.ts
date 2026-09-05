import type { ComponentType, LazyExoticComponent } from 'react';
import type { SettingsSchema, SettingsValueAdapter } from '../renderers/rendererSettingsTypes.js';
import type { SettingsTarget } from './settingsTargetGrammar.js';
export type PluginSettingValue = null | boolean | number | string | readonly PluginSettingValue[] | {
    readonly [key: string]: PluginSettingValue;
};
export interface PluginSettingsPageProps {
    readonly pluginId: string;
    readonly values: Readonly<Record<string, PluginSettingValue>>;
    setValue(key: string, value: PluginSettingValue): void;
    removeValue(key: string): void;
}
interface PluginSettingsPageBase {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly order?: number;
    /** Optional framework-neutral schema; without an adapter the page stays opaque. */
    readonly schema?: SettingsSchema;
    readonly valueAdapter?: SettingsValueAdapter;
}
export interface FirstPartyPluginSettingsPage extends PluginSettingsPageBase {
    readonly renderKind: 'first-party-react';
    readonly component: ComponentType<PluginSettingsPageProps> | LazyExoticComponent<ComponentType<PluginSettingsPageProps>>;
}
export interface IsolatedPluginSettingsPage extends PluginSettingsPageBase {
    readonly renderKind: 'isolated-surface';
    readonly surfaceId: string;
}
export type PluginSettingsPageContribution = FirstPartyPluginSettingsPage | IsolatedPluginSettingsPage;
export interface PluginSettingOption {
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
    readonly disabled?: boolean;
    readonly order?: number;
}
/**
 * Mutates the choices exposed by one host-owned setting without taking
 * ownership of the setting value or renderer. Contributions are applied in
 * registry order; remove runs before upsert inside each contribution.
 */
export interface PluginSettingOptionsContribution {
    readonly id: string;
    /** Stable host target. Theme fields use `theme.<ThemeFieldKey>`. */
    /** Structured target is canonical; string remains the legacy compatibility form. */
    readonly target: string | SettingsTarget;
    readonly order?: number;
    readonly remove?: readonly string[];
    readonly upsert?: readonly PluginSettingOption[];
}
export {};
