export interface PluginUiEventBridge {
    emit(event: string, detail?: unknown): void;
    on(event: string, listener: (detail: unknown) => void): () => void;
}
export type PluginUiUnmount = void | (() => void | Promise<void>) | {
    unmount(): void | Promise<void>;
};
export type PluginUiFramework = 'solid' | 'react' | 'webcomponent';
export interface PluginUiRuntime {
    readonly framework: PluginUiFramework;
    readonly version: string;
}
export interface PluginUiRuntimeResolution {
    readonly runtime: PluginUiRuntime;
    readonly deprecated: boolean;
}
/**
 * The mount function belongs to the plugin bundle. It may close over any React
 * version bundled by that plugin; the host never receives a React component.
 */
export interface PluginUiSurface {
    readonly id: string;
    /** Framework-neutral runtime metadata. */
    readonly runtime?: PluginUiRuntime;
    /** @deprecated API 1.0 compatibility alias; normalized into runtime. */
    readonly reactVersion?: string;
    readonly mount: (container: HTMLElement, bridge: PluginUiEventBridge) => PluginUiUnmount | Promise<PluginUiUnmount>;
}
export declare function resolvePluginUiRuntime(surface: Pick<PluginUiSurface, 'runtime' | 'reactVersion'>): PluginUiRuntimeResolution;
