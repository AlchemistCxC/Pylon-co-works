import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import type { ContextPanelContribution } from './contextPanelTypes.js';
export declare class ContextPanelRegistry {
    private readonly registry;
    register(identity: PluginIdentity, contribution: ContextPanelContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<ContextPanelContribution>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<ContextPanelContribution>;
    hasForWorkspace(workspaceKind: string): boolean;
}
