import { useLayoutEffect, useEffect, useRef } from 'react'
import { createSignal } from 'solid-js'

/**
 * React 树内挂载 Solid 子树的通用薄桥（#279 逐梯队 Solid 化的机制件）。
 *
 * - 容器 div 由 React 拥有，`display:contents` 使其不参与布局——Solid 子树的根元素
 *   直接成为 React 父布局的布局子项（flex/grid 语义原样保留）；
 * - `mount` 工厂由 `.solid.tsx` 侧导出（`renderXxx(container, latest): dispose` 形态），保证
 *   **Solid JSX 只出现在 solid 编译管线的文件里**；本文件及一切 React 侧薄桥不写 Solid JSX；
 * - **响应式 props**：`initial` 为首帧 props；此后每次 React 渲染经 layout effect 把最新
 *   props 推入 Solid 信号，`latest()` 是响应式访问器。Solid 侧用 `createMemo(latest().x)`
 *   按引用等值去重消费——语义等价于 React 的 deps 数组。**只被读取而不被追新的字段**
 *   （事件回调类）在调用点现场取 `latest().onXxx`，恒为最新闭包；
 * - StrictMode 双执行由 dispose 对称回收，无残留。
 */
export default function SolidMount<P>({ initial, mount }: {
  initial: P
  mount: (container: HTMLElement, latest: () => P) => () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const latestRef = useRef<P>(initial)
  latestRef.current = initial
  const setterRef = useRef<((value: P) => void) | null>(null)

  useLayoutEffect(() => {
    setterRef.current?.(latestRef.current)
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const [current, setCurrent] = createSignal<P>(latestRef.current)
    setterRef.current = setCurrent
    const dispose = mount(container, current)
    return () => {
      setterRef.current = null
      dispose()
    }
    // 挂载一次；props 更新走 setterRef 通道（见上方 layout effect）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={containerRef} style={{ display: 'contents' }} />
}
