import type { PluginIdentity } from './pluginIdentity.js';
import type { PluginActivationTransactions } from './pluginActivationContext.js';
import type { PluginHostServices } from './pluginHostServices.js';
export type HotSwapMode = 'parallel' | 'exclusive' | 'soft-remount' | 'restart-required';
export interface PluginUpdateResult {
    readonly pluginId: string;
    readonly previousRuntimeInstanceId: string;
    readonly runtimeInstanceId: string;
    readonly declaredMode: HotSwapMode;
    readonly adoptedMode: HotSwapMode;
}
/**
 * Collects every v2 contribution behind one candidate-only boundary. Individual
 * registries commit synchronously; no async/user code can observe a half-built
 * candidate between validate and the completed commit call.
 */
export declare class PluginContributionTransaction {
    readonly transactions: PluginActivationTransactions;
    private state;
    constructor(host: PluginHostServices, candidate: PluginIdentity, replacingRuntimeInstanceId: string);
    validate(): void;
    commit(): void;
    rollback(): void;
    revert(): void;
}
