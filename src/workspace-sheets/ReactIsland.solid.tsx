import { createEffect, onCleanup, onMount } from 'solid-js'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

/**
 * ReactIsland — Solid 树内挂载 React 子树的通用桥（SolidMount 的逆，#279 第 3 梯队）。
 *
 * 存在理由：标题栏的**插件贡献项**（component renderKind）按插件 API 是 React 组件，
 * 且依赖 React 的 ErrorBoundary（PluginContributionBoundary）与 Suspense——这三样只
 * 存在于 React 运行时。Solid 化的标题栏经本岛把它们留在 React root 里渲染。
 *
 * - 宿主 div 由 Solid 拥有（display:contents，不参与布局）；
 * - `render` 是响应式访问器：依赖（titlebarContext / 贡献快照）变化 → effect 重跑 →
 *   `root.render` 以最新 ReactNode 重渲染（React 自己 diff，不重挂）；
 * - 卸载时 `root.unmount()` 对称回收（延迟到微任务：RTL 清理会在 React 卸载流程内
 *   触发本清理，同步卸载撞 React「渲染期同步卸载」告警，测试白名单硬断言会拦）。
 */
export default function ReactIsland(p: { render: () => ReactNode }) {
  let host: HTMLDivElement | undefined
  let root: Root | null = null

  onMount(() => {
    root = createRoot(host!)
    root.render(p.render())
  })

  createEffect(() => {
    const node = p.render()
    root?.render(node)
  })

  onCleanup(() => {
    const rootToUnmount = root
    root = null
    setTimeout(() => rootToUnmount?.unmount(), 0)
  })

  return <div ref={element => { host = element }} style={{ display: 'contents' }} />
}
