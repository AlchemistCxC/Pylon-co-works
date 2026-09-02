export type PluginDataPlane = 'metadata' | 'context';
export type PluginNamespaceRoot = Record<string, Record<string, unknown>>;
export declare const PLUGIN_NAMESPACE_MAX_BYTES: number;
export declare function assertPluginPatch(patch: unknown): asserts patch is Record<string, unknown>;
export declare function normalizePluginNamespaceRoot(raw: unknown): PluginNamespaceRoot;
export declare function mergePluginNamespace(metadata: PluginNamespaceRoot, context: PluginNamespaceRoot, plane: PluginDataPlane, pluginId: string, patch: Record<string, unknown>): {
    metadata: PluginNamespaceRoot;
    context: PluginNamespaceRoot;
};
