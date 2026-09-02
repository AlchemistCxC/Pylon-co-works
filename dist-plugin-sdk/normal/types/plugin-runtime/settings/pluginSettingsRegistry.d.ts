import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import type { PluginSettingsPageContribution } from './pluginSettingsTypes.js';
export declare function validatePluginSettingsPage(page: PluginSettingsPageContribution): PluginSettingsPageContribution;
export declare class PluginSettingsPageRegistry {
    private readonly registry;
    register(owner: PluginIdentity, page: PluginSettingsPageContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<PluginSettingsPageContribution>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<PluginSettingsPageContribution>;
}
