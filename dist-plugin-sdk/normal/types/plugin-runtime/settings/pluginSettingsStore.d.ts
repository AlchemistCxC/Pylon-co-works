import type { PluginSettingValue } from './pluginSettingsTypes.js';
import type { SettingsValueAdapter } from '../renderers/rendererSettingsTypes.js';
export declare class PluginSettingsStore {
    private hydrated;
    private values;
    private readonly listeners;
    getSnapshot(pluginId: string): Readonly<Record<string, PluginSettingValue>>;
    get(pluginId: string, key: string): PluginSettingValue | undefined;
    set(pluginId: string, key: string, value: PluginSettingValue): void;
    remove(pluginId: string, key: string): void;
    subscribe(pluginId: string, listener: () => void): () => void;
    private hydrate;
    private persist;
    private publish;
}
/** Host-owned adapter that isolates each page/panel by plugin + contribution. */
export declare function createPluginSettingsValueAdapter(input: {
    readonly store: PluginSettingsStore;
    readonly ownerPluginId: string;
    readonly contributionId: string;
    readonly namespace: 'plugin-page' | 'context-panel';
}): SettingsValueAdapter;
