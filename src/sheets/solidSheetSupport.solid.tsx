/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createZustandSignal } from '../host/solidStoreBridge.ts'
import { DEFAULT_INTERFACE_MODE, useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { getInterfaceModeRegistry } from '../plugin-runtime/runtimeServices.ts'
import { findInterfaceModeContribution } from '../app/interfaceModeLookup.ts'
import type { InterfaceModeContribution } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'

/**
 * #515 sheet 视图 Solid 化的共享支撑件（仅 Solid 实体消费；React 类型图不触碰本文件）。
 *
 * - createRegistrySignal：useSyncExternalStore 语义的外部 store → Solid 信号；
 * - createActiveInterfaceModeContribution：useActiveInterfaceModeContribution 的 Solid
 *   等价（registry 真值 + 内置表回退，回退序与 React hook 逐项一致）；
 * - ReactIslandHost / mountReactIsland：Solid 树内挂载 React 组件的原语（#515 迁移期，
 *   部分子树仍是 React 面——批7 后随 React 面一并退役）。
 */

/** 外部 store（subscribe/getSnapshot 快照语义）→ Solid 信号（快照引用等值）。 */
export function createRegistrySignal<T>(
  store: { subscribe(listener: () => void): () => void },
  getSnapshot: () => T,
): () => T {
  const [value, setValue] = createSignal<T>(getSnapshot())
  // updater 形态：T 可能是任意值（含函数），走 (prev) => next 重载避开 Solid setter
  // 对「函数值」的排除分支。
  onCleanup(store.subscribe(() => setValue(() => getSnapshot())))
  return value
}

/** useActiveInterfaceModeContribution 的 Solid 等价（语义与 React hook 同源，A-V9）。 */
export function createActiveInterfaceModeContribution(): () => InterfaceModeContribution {
  const interfaceMode = createZustandSignal(useInterfaceModeStore, state => state.interfaceMode)
  const registry = getInterfaceModeRegistry()
  const snapshot = createRegistrySignal(registry, () => registry.getSnapshot())
  return createMemo(() =>
    snapshot().entries.find(entry => entry.value.id === interfaceMode())?.value
    ?? findInterfaceModeContribution(interfaceMode())
    ?? findInterfaceModeContribution(DEFAULT_INTERFACE_MODE)!)
}

export interface ReactIslandHandle {
  render(element: ReactElement): void
  dispose(): void
}

/**
 * React 岛挂载原语（WorkspaceTitlebarPluginIsland 的最小通用形）：`render` 经 React
 * reconcile 原位更新（不重挂），`dispose` 同步卸载 root。render 不用 flushSync——
 * 桥生命周期内的 flush 会被 React 拒绝并留下竞态（同 WorkspaceTitlebarPluginIsland
 * 的取舍）。
 */
export function mountReactIsland(container: HTMLElement): ReactIslandHandle {
  const root = createRoot(container)
  return {
    render: element => root.render(element),
    // 卸载延迟到宏任务：本 dispose 由 Solid onCleanup 触发，而 Solid 子树常在 React
    // 渲染/卸载提交期被回收——同步 unmount 会撞 React「渲染期同步卸载」告警并留竞态
    // （与 TemplateLibraryPreviewIsland / WorkspaceTitlebarPluginIsland 同款处理）。
    // 容器随宿主子树一起移除，延迟卸载无泄漏面。
    dispose: () => {
      const rootToUnmount = root
      setTimeout(() => rootToUnmount.unmount(), 0)
    },
  }
}

/**
 * React 岛宿主组件：`element()` 工厂产出的最新元素被推入 React root（容器
 * `display: contents` 不参与布局，与 SolidMount 同一约定）。依赖追踪发生在
 * props.element() 读取处（调用方包住要追的信号）；分支重挂交给外层 Show/Match，
 * 卸载对称回收。
 */
export function ReactIslandHost(props: { element: () => ReactElement }) {
  let host!: HTMLDivElement
  let island: ReactIslandHandle | null = null
  // 同一微任务批内的多次依赖触发合并为一次 root.render：bridgedProps 的初始
  // reconcile 会在挂载当拍再通知一次，若第二次 render 落在首帧 commit 中途，
  // React 会把岛内容整树重挂（实测 rendererMode 集成面 suite 双 mount）。
  let scheduled = false
  let pending: ReactElement | null = null
  let disposed = false
  createEffect(() => {
    const element = props.element()
    untrack(() => {
      if (!host || disposed) return
      island ??= mountReactIsland(host)
      pending = element
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        const current = pending
        pending = null
        if (!disposed && current) island!.render(current)
      })
    })
  })
  onCleanup(() => {
    disposed = true
    pending = null
    island?.dispose()
  })
  return <div ref={el => { host = el }} style={{ display: 'contents' }} />
}
