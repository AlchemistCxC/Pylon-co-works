import type { PluginIdentity } from './pluginIdentity.js';
import { PluginScope, type PluginScopeDisposeResult } from './pluginScope.js';
export declare class PluginActivationError extends Error {
    readonly identity: PluginIdentity;
    readonly cause: unknown;
    readonly rollback: PluginScopeDisposeResult;
    constructor(identity: PluginIdentity, cause: unknown, rollback: PluginScopeDisposeResult);
}
export interface PluginActivationTransaction {
    readonly identity: PluginIdentity;
    readonly scope: PluginScope;
    commit: () => PluginScope;
    rollback: (cause: unknown) => Promise<never>;
}
export declare function createPluginActivationTransaction(identity: PluginIdentity): PluginActivationTransaction;
