import type { ComponentType } from 'react';
import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable } from '../registry/types.js';
export interface PluginApplicationContribution {
    id: string;
    component: ComponentType;
}
export interface PluginApplicationRegistryTransaction {
    register(contribution: PluginApplicationContribution): AsyncDisposable;
    validate(): void;
    commit(): void;
    rollback(): void;
    revert(): void;
}
export interface PluginApplicationHost {
    register(owner: PluginIdentity, contribution: PluginApplicationContribution): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): PluginApplicationRegistryTransaction;
}
