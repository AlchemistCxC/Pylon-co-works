import type { RendererSettingValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.js';
export type PresetJsonValue = null | boolean | number | string | readonly PresetJsonValue[] | {
    readonly [key: string]: PresetJsonValue;
};
export interface PresetContribution {
    readonly ownerPluginId: string;
    readonly providerVersion: number;
    readonly policy: 'complete' | 'partial';
    readonly payload: PresetJsonValue;
}
export interface PresetBundleV2 {
    readonly manifestVersion: 2;
    readonly id?: string;
    readonly name: string;
    readonly source: 'builtin' | 'user' | 'plugin';
    readonly createdAt?: number;
    readonly updatedAt?: number;
    readonly contributions: Readonly<Record<string, PresetContribution>>;
    readonly unavailable?: Readonly<Record<string, PresetJsonValue>>;
}
export interface RendererPresetPayload {
    readonly values: Readonly<Record<string, RendererSettingValue>>;
    readonly unavailable: Readonly<Record<string, RendererSettingValue>>;
}
export interface PresentationPresetPayload {
    readonly activeProfileId: string;
    readonly rendererSuiteIdByMode: Readonly<Record<string, string>>;
}
export interface PresetCaptureScope {
    /** Optional provider ids when capturing/applying a selected settings area. */
    readonly providerIds?: readonly string[];
    /** Optional semantic areas (for example `theme.chat` or `renderer.tools`). */
    readonly areas?: readonly string[];
}
export interface PresetApplyContext {
    readonly scope?: PresetCaptureScope;
    readonly policy: 'complete' | 'partial';
    readonly bundleId?: string;
}
export interface PresetCoverage {
    /** Stable UI key; kept alongside providerId for v1 callers. */
    readonly id: string;
    readonly providerId: string;
    readonly label: string;
    readonly explicit: number;
    readonly defaulted: number;
    readonly unavailable: number;
    readonly state: 'explicit' | 'defaulted' | 'unavailable' | 'missing';
    readonly policy?: 'complete' | 'partial';
}
export interface PresetChangeSummary {
    readonly providerId: string;
    readonly label: string;
    readonly changed: number;
}
export interface PresetPreparedApply {
    readonly summary: readonly PresetChangeSummary[];
    commit(): void | Promise<void>;
    rollback(): void | Promise<void>;
}
export interface PresetProvider {
    readonly id: string;
    readonly ownerPluginId: string;
    readonly schemaVersion: number;
    readonly label: string;
    capture(scope?: PresetCaptureScope): PresetJsonValue;
    prepareApply(payload: PresetJsonValue, context?: PresetApplyContext): PresetPreparedApply;
    defaults(scope?: PresetCaptureScope): PresetJsonValue;
    migrate?(fromVersion: number, payload: PresetJsonValue): PresetJsonValue;
    describeCoverage?(payload: PresetJsonValue): PresetCoverage;
}
/** Small owner-neutral registry; values remain owned by providers, not Settings. */
export declare class PresetProviderRegistry {
    private readonly providers;
    register(provider: PresetProvider): () => void;
    list(): readonly PresetProvider[];
    resolve(id: string): PresetProvider | undefined;
}
export interface PreparedPresetBundle {
    readonly summary: readonly PresetChangeSummary[];
    commit(): void | Promise<void>;
    rollback(): void | Promise<void>;
}
/**
 * Prepare every available contribution before mutating any owner. Missing
 * providers are kept in the bundle's unavailable map by the caller; a
 * malformed or rejected contribution aborts the transaction and rolls back
 * every provider that was already prepared.
 */
export declare function preparePresetBundle(bundle: PresetBundleV2, registry: PresetProviderRegistry, scope?: PresetCaptureScope): PreparedPresetBundle;
/** Mark contributions whose owner is currently absent without dropping their
 * original payload. The envelope remains round-trippable for a later plugin
 * reload. */
export declare function markUnavailablePresetProviders(bundle: PresetBundleV2, registry: PresetProviderRegistry): PresetBundleV2;
/** Adapt the pre-v2 Theme-only custom preset without rewriting persisted data. */
export declare function adaptLegacyThemePreset(input: {
    readonly id: string;
    readonly name: string;
    readonly theme: PresetJsonValue;
    readonly createdAt?: number;
    readonly updatedAt?: number;
}): PresetBundleV2;
export declare function normalizePresetBundle(value: unknown): PresetBundleV2 | undefined;
export declare function createPresetBundle(input: {
    id: string;
    name: string;
    now: number;
    /** Preserve the original creation time when an existing preset is updated. */
    createdAt?: number;
    theme: PresetJsonValue;
    renderer?: RendererPresetPayload;
    presentation?: PresentationPresetPayload;
}): PresetBundleV2;
/** Read a contribution payload as a record (empty when absent/malformed). */
export declare function recordPayload(value: PresetJsonValue | undefined): Readonly<Record<string, PresetJsonValue>>;
export declare function presetCoverage(bundle: PresetBundleV2 | undefined): readonly PresetCoverage[];
