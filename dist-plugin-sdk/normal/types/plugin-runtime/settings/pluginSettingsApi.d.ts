import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { PluginSettingsPageRegistry } from './pluginSettingsRegistry.js';
import type { PluginSettingsStore } from './pluginSettingsStore.js';
import type { PluginSettingsPageContribution, PluginSettingValue } from './pluginSettingsTypes.js';
import type { PluginSettingOptionsContribution } from './pluginSettingsTypes.js';
import type { PluginSettingOptionsRegistry } from './pluginSettingOptionsRegistry.js';
export interface PluginSettingsApi {
    registerPage(page: PluginSettingsPageContribution): void;
    registerOptions(contribution: PluginSettingOptionsContribution): void;
    getValue(key: string): PluginSettingValue | undefined;
    setValue(key: string, value: PluginSettingValue): void;
    removeValue(key: string): void;
    subscribe(listener: () => void): () => void;
}
export declare function createPluginSettingsApi(registry: PluginSettingsPageRegistry, store: PluginSettingsStore, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<PluginSettingsPageContribution>, optionsRegistry?: PluginSettingOptionsRegistry, optionsTransaction?: RegistryTransaction<PluginSettingOptionsContribution>): PluginSettingsApi;
