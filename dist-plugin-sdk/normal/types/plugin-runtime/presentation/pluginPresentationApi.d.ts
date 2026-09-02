import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RegistryTransaction } from '../registry/types.js';
import type { PresentationProfileRegistry } from './presentationProfileRegistry.js';
import type { PresentationProfileContribution } from './presentationProfileTypes.js';
export interface PluginPresentationApi {
    registerProfile(contribution: PresentationProfileContribution): void;
}
export declare function createPluginPresentationApi(registry: PresentationProfileRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<PresentationProfileContribution>): PluginPresentationApi;
