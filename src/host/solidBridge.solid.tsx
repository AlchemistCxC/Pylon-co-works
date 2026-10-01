import { render } from 'solid-js/web'
import { createComponent, createEffect, on, untrack, type Component } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'

/**
 * #515 并行迁移批的通用 React↔Solid 桥面工厂（配套 host/SolidMount.tsx）。
 *
 * 每个被迁移组件的 React 侧薄桥只需三行：
 * ```tsx
 * const mountX = createSolidMount(XSolid)
 * export default function X(props: XProps) {
 *   return <SolidMount initial={props} mount={mountX} />
 * }
 * ```
 * Solid 实体组件照常写 `props.x`——`bridgedProps` 把 React 推来的最新 props 镜像成
 * solid store（reconcile 引用级细粒度更新），省掉 #279 时代逐字段 `latest().x` 的
 * 隧道改写。终态（批7）React 面退役后，本文件与 SolidMount 一并删除，消费者直连
 * `.solid` 实体。
 */

/**
 * 桥面纯数据形状拷贝：普通对象/数组递归复制，函数与类实例（Date/Map/React 组件等）
 * 原样保留。
 *
 * 为什么必须拷贝（#515 施工发现）：React 侧 props 经常**内嵌宿主 store 裸状态对象的
 * 引用**（如 SheetLayout 传给 RightRailHost 的 `sheet` 就是 workspaceStore 裸树里的
 * 条目）。`createStore` 按引用嵌入后，`reconcile` 的就地合并会把差异**写穿这条共享
 * 引用**，无声改坏外来 store 的裸状态（实测：keep-alive sheets 数组被复制出同 id 条目，
 * React 侧以 duplicate key 形式爆炸）。切断引用后 reconcile 只写桥面自己的副本。
 */
function cloneBridgeValue<T>(value: T, depth = 0): T {
  if (depth > 8) return value
  if (Array.isArray(value)) return value.map(item => cloneBridgeValue(item, depth + 1)) as unknown as T
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = cloneBridgeValue(item, depth + 1)
    return out as T
  }
  return value
}

/** 把 SolidMount 推流的 `latest()` 镜像为响应式 props store（必须在 render root 内调用）。 */
export function bridgedProps<P extends object>(latest: () => P): P {
  const [props, setProps] = createStore<P>(cloneBridgeValue({ ...untrack(latest) }))
  createEffect(on(latest, p => {
    setProps(reconcile(cloneBridgeValue(p), { key: 'value' }))
  }))
  return props
}

/** 由 Solid 实体组件造出 SolidMount 需要的 `mount(container, latest): dispose` 工厂。 */
export function createSolidMount<P extends object>(Component: Component<P>): (container: HTMLElement, latest: () => P) => () => void {
  return (container, latest) => render(() => createComponent(Component, bridgedProps(latest)), container)
}
