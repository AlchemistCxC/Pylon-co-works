import type { RegistryEntry } from '../registry/types.js';
import type { RendererSettingValue } from '../renderers/rendererSettingsTypes.js';
export type PresentationProfileFamily = 'terminal' | 'gui' | 'reading' | 'hybrid' | 'custom';
export interface PresentationProfileVisualAssets {
    readonly promptGlyph?: string;
    readonly assistantGlyph?: string;
    readonly runningGlyph?: string;
    readonly completedGlyph?: string;
    readonly failedGlyph?: string;
}
/**
 * A presentation profile is a coherent visual/interaction delta. It does not
 * choose the rendering engine (React/Solid/isolated surface) and it does not
 * own runtime state. Tokens are validated against the host theme schema.
 */
export interface PresentationProfileContribution {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly family: PresentationProfileFamily;
    /** Omitted legacy profiles belong to terminal-like. */
    /** Stable Interface Mode id; omitted legacy profiles belong to terminal-like. */
    readonly interfaceMode?: string;
    readonly order?: number;
    readonly tokens: Readonly<Record<string, unknown>>;
    readonly kindTokens?: Readonly<Record<string, Readonly<Record<string, RendererSettingValue>>>>;
    readonly assets?: Readonly<PresentationProfileVisualAssets>;
}
export type PresentationProfileRegistryEntry = RegistryEntry<PresentationProfileContribution>;
