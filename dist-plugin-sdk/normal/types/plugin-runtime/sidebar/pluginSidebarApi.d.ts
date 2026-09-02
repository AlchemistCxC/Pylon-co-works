import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { AgentSidebarRegistry } from './sidebarRegistry.js';
import type { AgentSidebarContribution } from './sidebarTypes.js';
export interface PluginSidebarApi {
    registerAgentSidebarContribution(contribution: AgentSidebarContribution): void;
}
export declare function createPluginSidebarApi(registry: AgentSidebarRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<AgentSidebarContribution>): PluginSidebarApi;
