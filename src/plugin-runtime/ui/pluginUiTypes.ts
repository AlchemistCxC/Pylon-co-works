export interface PluginUiEventBridge {
  emit(event: string, detail?: unknown): void
  on(event: string, listener: (detail: unknown) => void): () => void
}

export type PluginUiUnmount = void | (() => void | Promise<void>) | {
  unmount(): void | Promise<void>
}

/**
 * The mount function belongs to the plugin bundle. It may close over any React
 * version bundled by that plugin; the host never receives a React component.
 */
export interface PluginUiSurface {
  readonly id: string
  readonly reactVersion: string
  readonly mount: (
    container: HTMLElement,
    bridge: PluginUiEventBridge,
  ) => PluginUiUnmount | Promise<PluginUiUnmount>
}
