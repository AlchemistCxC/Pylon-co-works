import type { PylonPluginManifest } from '../../plugin-runtime/packageManifest.js';
import type { ClientTransport } from './pluginClientTransport.js';
export interface PluginFileMetadata {
    path: string;
    size: number;
    mime: string;
}
export interface PluginPackageDescriptor {
    pluginId: string;
    version: string;
    packageInstanceId: string;
    manifest: PylonPluginManifest;
    files: PluginFileMetadata[];
    totalBytes: number;
    active: boolean;
}
export interface PluginPackageOperationResult {
    operationId: string;
    package: PluginPackageDescriptor;
    previousActive?: string;
}
export interface InstalledPluginPackage {
    package: PluginPackageDescriptor;
    enabled: boolean;
}
export interface PluginPackageClientOptions {
    transport: ClientTransport;
    fetch?: typeof globalThis.fetch;
    /** Test/browser adapter; production uses Tauri's platform-aware protocol URL conversion. */
    convertResourceUrl?: (canonicalUrl: string) => string;
}
export declare function createPluginPackageClient(options: PluginPackageClientOptions): {
    inspect: (sourcePath: string) => Promise<PluginPackageDescriptor>;
    install: (sourcePath: string, expectedId: string) => Promise<PluginPackageOperationResult>;
    update: (sourcePath: string, expectedId: string) => Promise<PluginPackageOperationResult>;
    stage: (sourcePath: string, expectedId: string) => Promise<PluginPackageOperationResult>;
    commitStage: (operationId: string) => Promise<PluginPackageOperationResult>;
    abortStage: (operationId: string) => Promise<void>;
    versions: (pluginId: string) => Promise<PluginPackageDescriptor[]>;
    list: () => Promise<InstalledPluginPackage[]>;
    setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
    rollback: (pluginId: string, packageInstanceId?: string) => Promise<PluginPackageOperationResult>;
    uninstall: (pluginId: string, purgeData?: boolean) => Promise<void>;
    readText: (packageInstanceId: string, path: string) => Promise<string>;
    resourceUrl: (packageInstanceId: string, path: string, runtimeInstanceId?: string) => Promise<string>;
    /** Large files stay outside JSON invoke; consumers read the response stream directly. */
    openStream(packageInstanceId: string, path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
    /** Range reads permit bounded random access to models, WASM and other large assets. */
    readRange(packageInstanceId: string, path: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
    createRuntime: (runtimeInstanceId: string) => Promise<void>;
    cleanupRuntime: (runtimeInstanceId: string) => Promise<void>;
};
export type PluginPackageClient = ReturnType<typeof createPluginPackageClient>;
