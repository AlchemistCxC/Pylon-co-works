import type { PluginProcessClient } from '../../infrastructure/plugins/pluginProcessClient.js';
import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { PluginProcessApi } from './processTypes.js';
/** Process handles are transaction resources: rollback/deactivate drains them in LIFO order. */
export declare function createPluginProcessApi(identity: PluginIdentity, scope: PluginScope, client: PluginProcessClient): PluginProcessApi;
