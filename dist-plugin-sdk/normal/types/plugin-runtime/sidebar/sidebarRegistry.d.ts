import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.js';
import type { AgentSidebarContribution, AgentSidebarMode } from './sidebarTypes.js';
export declare class AgentSidebarRegistry {
    private readonly registry;
    register(identity: PluginIdentity, contribution: AgentSidebarContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<AgentSidebarContribution>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<AgentSidebarContribution>;
    list(mode?: AgentSidebarMode): readonly AgentSidebarContribution[];
}
