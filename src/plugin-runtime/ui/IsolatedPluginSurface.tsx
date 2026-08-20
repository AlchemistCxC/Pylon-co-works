import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { getPluginUiRegistry } from '../runtimeServices.ts'
import type { PluginUiEventBridge, PluginUiUnmount } from './pluginUiTypes.ts'

function createBridge(onEvent?: (event: string, detail: unknown) => void): PluginUiEventBridge & { clear(): void } {
  const listeners = new Map<string, Set<(detail: unknown) => void>>()
  return {
    emit(event, detail) {
      onEvent?.(event, detail)
      for (const listener of [...(listeners.get(event) ?? [])]) listener(detail)
    },
    on(event, listener) {
      const group = listeners.get(event) ?? new Set()
      group.add(listener)
      listeners.set(event, group)
      return () => {
        group.delete(listener)
        if (group.size === 0) listeners.delete(event)
      }
    },
    clear: () => listeners.clear(),
  }
}

async function unmount(result: PluginUiUnmount): Promise<void> {
  if (typeof result === 'function') await result()
  else if (result) await result.unmount()
}

export function IsolatedPluginSurface({
  surfaceId,
  className,
  input,
  onEvent,
}: {
  surfaceId: string
  className?: string
  input?: unknown
  onEvent?: (event: string, detail: unknown) => void
}) {
  const registry = getPluginUiRegistry()
  const snapshot = useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.getSnapshot(),
    () => registry.getSnapshot(),
  )
  const entry = useMemo(
    () => snapshot.entries.find(candidate => candidate.value.id === surfaceId),
    [snapshot, surfaceId],
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef(input)
  const onEventRef = useRef(onEvent)
  const bridgeRef = useRef<(PluginUiEventBridge & { clear(): void }) | null>(null)
  inputRef.current = input
  onEventRef.current = onEvent

  useEffect(() => {
    const container = containerRef.current
    if (!container || !entry) return
    const bridge = createBridge((event, detail) => onEventRef.current?.(event, detail))
    bridgeRef.current = bridge
    let disposed = false
    let result: PluginUiUnmount
    void Promise.resolve(entry.value.mount(container, bridge)).then(value => {
      if (disposed) void unmount(value)
      else {
        result = value
        bridge.emit('host:input', inputRef.current)
      }
    })
    return () => {
      disposed = true
      bridge.clear()
      bridgeRef.current = null
      void unmount(result)
      container.replaceChildren()
    }
  }, [entry])

  useEffect(() => {
    bridgeRef.current?.emit('host:input', input)
  }, [input])

  return (
    <div
      ref={containerRef}
      className={className}
      data-plugin-ui-surface={surfaceId}
      data-plugin-ui-owner={entry?.ownerPluginId}
      data-plugin-react-version={entry?.value.reactVersion}
    />
  )
}
