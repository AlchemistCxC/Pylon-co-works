/**
 * workspaceRegistry — Workspace 元数据响应式注册表（阶段 6 首个切片）。
 *
 * 单一真值：完整 WorkspaceTypeDefinition（metadata + component + state codec）。
 * v2 plugin 经 PluginScope 注册/注销；revision 驱动 React 响应式消费。
 */
import type { PluginIdentity } from '../plugin-runtime/pluginIdentity.js';
import type { AsyncDisposable } from '../plugin-runtime/registry/types.js';
import type { SheetInput } from './sheetTypes.js';
import type { WorkspaceLaunchOption, WorkspaceTypeDefinition } from './workspaceTypes.js';
export interface WorkspaceRegistryEntry {
    readonly ownerPluginId: string;
    readonly ownerRuntimeInstanceId: string;
    readonly descriptor: WorkspaceTypeDefinition;
}
export interface WorkspaceRegistrySnapshot {
    readonly revision: number;
    readonly entries: readonly WorkspaceRegistryEntry[];
    readonly workspaces: readonly WorkspaceTypeDefinition[];
    readonly launchOptions: readonly WorkspaceLaunchOption[];
}
export interface WorkspaceRegistryTransaction {
    register(descriptor: WorkspaceTypeDefinition): AsyncDisposable;
    validate(): void;
    commit(): void;
    rollback(): void;
    revert(): void;
}
export declare class WorkspaceRegistryStore {
    private readonly entries;
    private readonly listeners;
    private revision;
    private snapshot;
    register(owner: PluginIdentity, descriptor: WorkspaceTypeDefinition): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): WorkspaceRegistryTransaction;
    resolve(kind: unknown): WorkspaceTypeDefinition | undefined;
    list(): readonly WorkspaceTypeDefinition[];
    listLaunchOptions(): readonly WorkspaceLaunchOption[];
    resolveSingletonKey(input: Pick<SheetInput, 'kind' | 'agentId' | 'singletonKey' | 'metadata'>): string | undefined;
    subscribe(listener: () => void): () => void;
    getSnapshot(): WorkspaceRegistrySnapshot;
    /** Clears entries and subscriptions for HMR/test teardown. */
    dispose(): void;
    private publish;
}
/** RuntimeServices composition root may replace the compatibility owner. */
export declare function setWorkspaceRegistryStore(next: WorkspaceRegistryStore): void;
export declare function getWorkspaceRegistryStore(): WorkspaceRegistryStore;
export declare function registerWorkspace(owner: PluginIdentity, descriptor: WorkspaceTypeDefinition): AsyncDisposable;
export declare function resolveWorkspace(kind: unknown): WorkspaceTypeDefinition | undefined;
export declare function listWorkspaces(): readonly WorkspaceTypeDefinition[];
export declare function listWorkspaceLaunchOptions(): readonly WorkspaceLaunchOption[];
export declare function resolveSheetSingletonKey(input: Pick<SheetInput, 'kind' | 'agentId' | 'singletonKey' | 'metadata'>): string | undefined;
export declare function subscribeWorkspaceRegistry(listener: () => void): () => void;
export declare function getWorkspaceRegistrySnapshot(): WorkspaceRegistrySnapshot;
export declare function beginWorkspaceShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): WorkspaceRegistryTransaction;
