import type { PluginSettingValue } from './pluginSettingsTypes.js';
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
