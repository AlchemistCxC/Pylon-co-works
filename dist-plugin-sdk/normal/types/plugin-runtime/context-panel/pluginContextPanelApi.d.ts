import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { ContextPanelRegistry } from './contextPanelRegistry.js';
import type { ContextPanelContribution } from './contextPanelTypes.js';
export interface PluginContextPanelApi {
    register(contribution: ContextPanelContribution): void;
}
export declare function createPluginContextPanelApi(registry: ContextPanelRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<ContextPanelContribution>): PluginContextPanelApi;
