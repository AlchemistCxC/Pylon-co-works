import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistryEntry, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import type { PluginSettingOption, PluginSettingOptionsContribution } from './pluginSettingsTypes.js';
export declare function validatePluginSettingOptionsContribution(contribution: PluginSettingOptionsContribution): PluginSettingOptionsContribution;
export declare class PluginSettingOptionsRegistry {
    private readonly registry;
    register(owner: PluginIdentity, contribution: PluginSettingOptionsContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<PluginSettingOptionsContribution>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<PluginSettingOptionsContribution>;
}
interface ResolvedOption extends PluginSettingOption {
    readonly label: string;
    readonly contributionId?: string;
}
/** Pure resolver shared by Settings controls and contract tests. */
export declare function resolvePluginSettingOptions(target: string, base: readonly PluginSettingOption[], entries: readonly RegistryEntry<PluginSettingOptionsContribution>[]): readonly ResolvedOption[];
export {};
