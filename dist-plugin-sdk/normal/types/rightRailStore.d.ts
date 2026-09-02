export declare const RIGHT_RAIL_MIN_WIDTH = 220;
export declare const RIGHT_RAIL_MAX_WIDTH = 560;
export declare const RIGHT_RAIL_DEFAULT_WIDTH = 320;
export declare const LEFT_RAIL_MIN_WIDTH = 160;
export declare const LEFT_RAIL_MAX_WIDTH = 520;
export declare const LEFT_RAIL_DEFAULT_WIDTH = 250;
export type RightRailBackgroundSizing = 'fit' | 'fill' | 'stretch';
export interface RightRailBackgroundPresentation {
    readonly src: string;
    readonly sizing: RightRailBackgroundSizing;
    /** Width of the rail when the asset was imported. */
    readonly baseWidth: number;
    readonly naturalWidth?: number;
    readonly naturalHeight?: number;
}
interface RightRailState {
    leftRailWidth: number;
    leftRailCollapsed: boolean;
    collapsed: boolean;
    width: number;
    activePanelId: string | null;
    background: RightRailBackgroundPresentation | null;
    setCollapsed: (collapsed: boolean) => void;
    setLeftRailWidth: (width: number) => void;
    setLeftRailCollapsed: (collapsed: boolean) => void;
    setWidth: (width: number) => void;
    setActivePanel: (panelId: string | null) => void;
    setBackground: (background: RightRailBackgroundPresentation | null) => void;
}
export declare function clampRightRailWidth(width: number): number;
/** Application-level right rail state. It intentionally lives outside Sheet state. */
export declare const useRightRailStore: import("zustand").UseBoundStore<Omit<import("zustand").StoreApi<RightRailState>, "setState" | "persist"> & {
    setState(partial: RightRailState | Partial<RightRailState> | ((state: RightRailState) => RightRailState | Partial<RightRailState>), replace?: false): unknown;
    setState(state: RightRailState | ((state: RightRailState) => RightRailState), replace: true): unknown;
    persist: {
        setOptions: (options: Partial<import("zustand/middleware").PersistOptions<RightRailState, unknown, unknown>>) => void;
        clearStorage: () => void;
        rehydrate: () => Promise<void> | void;
        hasHydrated: () => boolean;
        onHydrate: (fn: (state: RightRailState) => void) => () => void;
        onFinishHydration: (fn: (state: RightRailState) => void) => () => void;
        getOptions: () => Partial<import("zustand/middleware").PersistOptions<RightRailState, unknown, unknown>>;
    };
}>;
export {};
