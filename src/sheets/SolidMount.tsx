import { useEffect, useRef } from 'react'

/**
 * React 树内挂载 Solid 子树的通用薄桥（#279 逐梯队 Solid 化的机制件）。
 *
 * - 容器 div 由 React 拥有，`display:contents` 使其不参与布局——Solid 子树的根元素
 *   直接成为 React 父布局的布局子项（flex/grid 语义原样保留）；
 * - `mount` 工厂由 `.solid.tsx` 侧导出（`renderXxx(container): dispose` 形态），保证
 *   **Solid JSX 只出现在 solid 编译管线的文件里**；本文件及一切 React 侧薄桥不写 Solid JSX；
 * - **按挂载捕获契约**：`mount` 只在 React 挂载时执行一次，props（sheet/ctx 等）按挂载
 *   捕获。被迁组件的跨桥数据必须满足「按挂载稳定」——sheet 注册表传入的 record 与布局层
 *   ctx 正是如此；Solid 子树内部的可变状态走信号，不跨桥。StrictMode 双执行由 dispose
 *   对称回收，无残留。
 */
export default function SolidMount({ mount }: { mount: (container: HTMLElement) => () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef(mount)
  mountRef.current = mount
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const dispose = mountRef.current(container)
    return () => dispose()
  }, [])
  return <div ref={containerRef} style={{ display: 'contents' }} />
}
