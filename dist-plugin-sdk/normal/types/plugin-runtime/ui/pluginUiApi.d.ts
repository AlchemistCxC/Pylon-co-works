import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { PluginUiRegistry } from './pluginUiRegistry.js';
import type { PluginUiSurface } from './pluginUiTypes.js';
export interface PluginUiApi {
    registerSurface(surface: PluginUiSurface): void;
}
export declare function createPluginUiApi(registry: PluginUiRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<PluginUiSurface>): PluginUiApi;
