import { HookRegistry } from './hookRegistry.js';
import type { HookCircuitDescriptor, HookInvocationResult, HookName, HookTraceEntry } from './hookTypes.js';
export interface HookRuntimeOptions {
    failureLimit?: number;
    cooldownMs?: number;
    traceLimit?: number;
    onDisablePlugin?: (pluginId: string) => void | Promise<void>;
}
export declare class HookRuntime {
    readonly registry: HookRegistry;
    private readonly circuits;
    private readonly disabledHandlers;
    private readonly activeLeases;
    private readonly traceListeners;
    private readonly failureLimit;
    private readonly cooldownMs;
    private readonly traceLimit;
    private readonly onDisablePlugin?;
    private traces;
    private invocationSequence;
    private traceRevision;
    private currentTraceSnapshot;
    constructor(registry?: HookRegistry, options?: HookRuntimeOptions);
    hasEnabledHooks(hookName: HookName, enabledPluginIds?: readonly string[]): boolean;
    invoke<TEvent>(hookName: HookName, event: TEvent, enabledPluginIds?: readonly string[]): Promise<HookInvocationResult<TEvent>>;
    drain(runtimeInstanceId: string, timeoutMs?: number): Promise<void>;
    traceSnapshot(): Readonly<{
        revision: number;
        entries: readonly HookTraceEntry[];
    }>;
    subscribeTrace(listener: () => void): () => void;
    circuitsSnapshot(): HookCircuitDescriptor[];
    reset(): void;
    private resolve;
    private circuitOpen;
    private recordFailure;
    private handleFailure;
    private pushSuccessTrace;
    private pushTrace;
    private addLease;
    private removeLease;
}
