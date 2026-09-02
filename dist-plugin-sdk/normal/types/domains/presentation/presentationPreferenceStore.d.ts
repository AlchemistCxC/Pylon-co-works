export declare const DEFAULT_PRESENTATION_PROFILE_ID = "builtin.presentation.terminal-classic";
interface PresentationPreferenceState {
    activeProfileId: string;
    /** User-selected Renderer Suite per Interface Mode. Unknown ids are retained for recovery. */
    rendererSuiteIdByMode: Record<string, string>;
    setActiveProfileId(id: string): void;
    setRendererSuiteId(mode: string, suiteId: string): void;
}
type LegacyPresentationPreferences = {
    activeProfileId?: string;
    messageRendererId?: string;
};
export type PersistedPresentationPreferences = Partial<Pick<PresentationPreferenceState, 'activeProfileId' | 'rendererSuiteIdByMode'>> & LegacyPresentationPreferences;
/**
 * v2 stored a single message renderer. Preserve that choice as a Suite choice
 * for every built-in mode; ids we do not recognise remain visible as
 * unavailable preferences instead of being silently replaced.
 */
export declare function migratePresentationPreferences(persisted: unknown, version: number): PersistedPresentationPreferences;
export declare const usePresentationPreferenceStore: import("zustand").UseBoundStore<Omit<import("zustand").StoreApi<PresentationPreferenceState>, "setState" | "persist"> & {
    setState(partial: PresentationPreferenceState | Partial<PresentationPreferenceState> | ((state: PresentationPreferenceState) => PresentationPreferenceState | Partial<PresentationPreferenceState>), replace?: false): unknown;
    setState(state: PresentationPreferenceState | ((state: PresentationPreferenceState) => PresentationPreferenceState), replace: true): unknown;
    persist: {
        setOptions: (options: Partial<import("zustand/middleware").PersistOptions<PresentationPreferenceState, unknown, unknown>>) => void;
        clearStorage: () => void;
        rehydrate: () => Promise<void> | void;
        hasHydrated: () => boolean;
        onHydrate: (fn: (state: PresentationPreferenceState) => void) => () => void;
        onFinishHydration: (fn: (state: PresentationPreferenceState) => void) => () => void;
        getOptions: () => Partial<import("zustand/middleware").PersistOptions<PresentationPreferenceState, unknown, unknown>>;
    };
}>;
export {};
