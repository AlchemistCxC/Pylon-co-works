import type { RendererSettingValue } from './rendererSettingsTypes.js';
export interface RendererSettingsStoreSnapshot {
    readonly schemaVersion: number;
    readonly values: Readonly<Record<string, RendererSettingValue>>;
    readonly unavailable: Readonly<Record<string, RendererSettingValue>>;
    readonly sessionPreview: Readonly<Record<string, RendererSettingValue>>;
    readonly diagnostics: readonly {
        readonly code: string;
        readonly message: string;
        readonly key?: string;
    }[];
}
export interface RendererSettingsStoreOptions {
    readonly storage?: Storage;
    readonly storageKey?: string;
    readonly schemaVersion?: number;
    readonly migrate?: (version: number, values: Readonly<Record<string, RendererSettingValue>>) => Readonly<Record<string, RendererSettingValue>>;
}
export interface RendererSettingsStore {
    getSnapshot(): RendererSettingsStoreSnapshot;
    subscribe(listener: () => void): () => void;
    setOverride(key: string, value: RendererSettingValue): void;
    removeOverride(key: string): void;
    markUnavailable(key: string, value: RendererSettingValue): void;
    restoreUnavailable(key: string): void;
    replaceOverrides(values: Readonly<Record<string, RendererSettingValue>>, unavailable?: Readonly<Record<string, RendererSettingValue>>): void;
    setSessionPreview(values: Readonly<Record<string, RendererSettingValue>>): void;
    clearSessionPreview(key?: string): void;
    reset(scope?: string): void;
    clearDiagnostics(): void;
}
export declare function createRendererSettingsStore(options?: RendererSettingsStoreOptions): RendererSettingsStore;
export declare const createRendererSettingsOverrideStore: typeof createRendererSettingsStore;
