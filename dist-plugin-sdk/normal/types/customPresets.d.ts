import type { ThemeSettings } from './store';
import { type PresetBundleV2 } from './domains/theme/presetBundle.js';
export interface CustomPreset {
    id: string;
    name: string;
    theme: Partial<ThemeSettings>;
    createdAt: number;
    updatedAt: number;
    /** v2 owner contributions; absent on legacy Theme-only presets. */
    bundle?: PresetBundleV2;
}
export declare function createCustomPresetId(now: number, existingIds?: readonly string[]): string;
/**
 * Custom preset ids have their own namespace.  Persisted data predating the
 * namespace migration may contain a bare id; keeping this conversion in one
 * helper prevents the list item, appliedPreset and bundle envelope from
 * drifting apart.
 */
export declare function normalizeCustomPresetId(value: string): string;
export declare function pickCustomPresetTheme(state: object): Partial<ThemeSettings>;
export declare function createCustomPreset(name: string, theme: Partial<ThemeSettings>, now?: number): CustomPreset;
export declare function upsertCustomPreset(presets: CustomPreset[], preset: CustomPreset): CustomPreset[];
export declare function deleteCustomPreset(presets: CustomPreset[], id: string): CustomPreset[];
export declare function normalizeCustomPresets(value: unknown): CustomPreset[];
