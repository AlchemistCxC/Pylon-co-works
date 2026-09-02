import type { PresetApplyContext, PresetCaptureScope, PresetJsonValue, PresetProviderRegistry, PresentationPresetPayload, RendererPresetPayload } from './presetBundle.js';
export interface FirstPartyPresetProviderDeps {
    readonly captureTheme: (scope?: PresetCaptureScope) => PresetJsonValue;
    readonly applyTheme: (payload: PresetJsonValue, context: PresetApplyContext) => void;
    readonly restoreTheme: () => void;
    readonly capturePresentation: (scope?: PresetCaptureScope) => PresentationPresetPayload;
    readonly applyPresentation: (payload: Partial<PresentationPresetPayload>, context: PresetApplyContext) => void;
    readonly restorePresentation: () => void;
    readonly captureRenderer: (scope?: PresetCaptureScope) => RendererPresetPayload;
    readonly applyRenderer: (payload: Partial<RendererPresetPayload>, context: PresetApplyContext) => void;
    readonly restoreRenderer: () => void;
}
export declare function createFirstPartyPresetProviderRegistry(deps: FirstPartyPresetProviderDeps): PresetProviderRegistry;
