import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { SessionCreationRegistry, SessionCreationRegistryTransaction } from './sessionCreationRegistry.js';
import type { SessionCreationArtifactHandler, SessionCreationCompiler, SessionCreationContribution } from './sessionCreationTypes.js';
export interface PluginSessionCreationApi {
    registerContribution(contribution: SessionCreationContribution): void;
    registerCompiler(compiler: SessionCreationCompiler): void;
    registerArtifactHandler(handler: SessionCreationArtifactHandler): void;
}
export declare function createPluginSessionCreationApi(registry: SessionCreationRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: SessionCreationRegistryTransaction): PluginSessionCreationApi;
