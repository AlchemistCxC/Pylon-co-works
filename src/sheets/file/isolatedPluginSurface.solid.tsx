import { createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'
import { getPluginUiRegistry } from '../../plugin-runtime/runtimeServices.ts'
import type { PluginUiEventBridge, PluginUiUnmount } from '../../plugin-runtime/ui/pluginUiTypes.ts'
import { resolvePluginUiRuntime } from '../../plugin-runtime/ui/pluginUiTypes.ts'

/** registry 快照 → Solid 只读信号（快照引用等值，与 WorkspaceTitlebar.solid 同一形态）。 */
function createRegistrySignal<T>(store: { subscribe(listener: () => void): () => void; getSnapshot(): T }): () => T {
  // updater 形态：T 可能是任意值（含函数），走 (prev) => next 重载避开 Solid setter
  // 对「函数值」的排除分支。
  const [snapshot, setSnapshot] = createSignal<T>(store.getSnapshot())
  onCleanup(store.subscribe(() => setSnapshot(() => store.getSnapshot())))
  return snapshot
}

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

/**
 * IsolatedPluginSurfaceProps — 与 React 原件（plugin-runtime/ui/IsolatedPluginSurface.tsx）
 * 逐字段一致。
 */
export interface IsolatedPluginSurfaceProps {
  surfaceId: string
  className?: string
  input?: unknown
  onEvent?: (event: string, detail: unknown) => void
}

/**
 * IsolatedPluginSurface 的 Solid 实体（#515：FileSheetView Solid 化后，插件 isolated
 * surface 挂载面随之需要 Solid 形态；逐行移植 React 原件的注册表订阅/挂载生命周期/
 * host:input 推流语义与 data-* DOM 契约）。原件保留（App/Sidebar 等 React 消费面仍在）。
 */
export function IsolatedPluginSurfaceSolid(props: IsolatedPluginSurfaceProps) {
  const snapshot = createRegistrySignal(getPluginUiRegistry())
  const entry = createMemo(() => snapshot().entries.find(candidate => candidate.value.id === props.surfaceId))
  const runtime = createMemo(() => entry() ? resolvePluginUiRuntime(entry()!.value).runtime : undefined)

  let containerElement: HTMLDivElement | undefined
  let bridgeRef: (PluginUiEventBridge & { clear(): void }) | null = null

  createEffect(() => {
    const currentEntry = entry()
    const container = containerElement
    if (!container || !currentEntry) return
    const bridge = createBridge((event, detail) => props.onEvent?.(event, detail))
    bridgeRef = bridge
    let disposed = false
    let result: PluginUiUnmount
    void Promise.resolve(currentEntry.value.mount(container, bridge)).then(value => {
      if (disposed) void unmount(value)
      else {
        result = value
        bridge.emit('host:input', props.input)
      }
    })
    onCleanup(() => {
      disposed = true
      bridge.clear()
      bridgeRef = null
      void unmount(result)
      container.replaceChildren()
    })
  })

  // input 变化 → 推流 host:input（React 版 useEffect [input] 同语义；挂载初期 bridge
  // 未就绪时静默跳过，由 mount 兑现回调补发）。
  createEffect(on(() => props.input, currentInput => {
    bridgeRef?.emit('host:input', currentInput)
  }))

  return (
    <div
      ref={element => { containerElement = element }}
      class={props.className}
      data-plugin-ui-surface={props.surfaceId}
      data-plugin-ui-owner={entry()?.ownerPluginId}
      data-plugin-framework={runtime()?.framework}
      data-plugin-runtime-version={runtime()?.version}
      data-plugin-react-version={runtime()?.framework === 'react' ? runtime()?.version : undefined}
    />
  )
}
