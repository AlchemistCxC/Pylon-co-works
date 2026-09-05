import type { BuiltinPluginDefinition } from './pluginRuntime.js';
import type { HotSwapMode } from './shadowUpdate.js';
export declare const PYLON_PLUGIN_API_MIN: "1.0";
export declare const PYLON_PLUGIN_API_LATEST: "1.2";
/** 宿主接受的全部 API 小版本（allowlist）：minor 只做加法且向后兼容，
 *  1.0 插件在 1.1/1.2 宿主继续激活；未知更高版本拒绝并提示升级宿主。 */
export declare const PYLON_PLUGIN_API_SUPPORTED: readonly ["1.0", "1.1", "1.2"];
export type PylonPluginApiVersion = (typeof PYLON_PLUGIN_API_SUPPORTED)[number];
/** @deprecated 语义是宿主接受的最低版本，改用 PYLON_PLUGIN_API_MIN */
export declare const PYLON_PLUGIN_API_VERSION: "1.0";
export declare const PYLON_PLUGIN_MANIFEST_FILE: "pylon-plugin.json";
/** API 1.2 capability 封闭词表（只增不改）：manifest 可声明的宿主能力。 */
export declare const PYLON_PLUGIN_CAPABILITIES: readonly ["plugin.management"];
export type PylonPluginCapability = (typeof PYLON_PLUGIN_CAPABILITIES)[number];
export declare class PluginManifestError extends Error {
    readonly field: string;
    readonly code = "plugin_manifest_invalid";
    constructor(field: string, message: string);
}
export interface PylonPluginManifest {
    readonly schema: 1;
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly api: PylonPluginApiVersion;
    readonly kind: NonNullable<BuiltinPluginDefinition['kind']>;
    readonly web: {
        readonly entry: string;
        readonly styles?: readonly string[];
    };
    readonly executables?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
    readonly conflicts?: readonly string[];
    readonly activation?: {
        readonly events: readonly string[];
    };
    readonly hotSwap?: {
        readonly mode: HotSwapMode;
        readonly drainTimeoutMs?: number;
    };
    readonly reactVersion?: string;
    /** API 1.2 新增：声明所需的宿主能力（封闭词表，见 PYLON_PLUGIN_CAPABILITIES）；
     *  1.0/1.1 manifest 出现该字段仍按 removed-field 拒绝。 */
    readonly capabilities?: readonly string[];
}
export declare function parsePylonPluginManifest(source: string | unknown): PylonPluginManifest;
