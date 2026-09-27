import { createSignal, onCleanup } from 'solid-js'

/** zustand store 的最小结构面（Hook 对象天然满足；类型侧不引 react）。 */
interface ZustandStoreLike<T> {
  getState: () => T
  subscribe: (listener: (state: T) => void) => () => void
}

/**
 * zustand store → Solid 只读信号（#279 Solid 化迁移期的桥接原语）。
 *
 * 订阅随 Solid owner（组件/effect 根）自动回收；selector 语义与 React 侧
 * `useXxxStore(selector)` 一致。信号默认按引用判等——zustand 状态切片在未变时
 * 引用稳定，不会产生多余的通知，与 React 侧的消费习惯对齐。
 * 迁移终点是 store 全量 Solid 化，届时此桥与 zustand 一并退役。
 *
 * ⚠️ selector 只在 store 通知时重跑（审查 #312 P3）：不得依赖 store 外的响应式
 * 状态——那类依赖变化不会触发 selector 重算，信号会持旧值（例：selector 里读
 * 组件的 path()/context() memo，切文件后版本值仍旧）。需要响应外部状态时在
 * 组件侧用 createMemo 包一层，或把外部状态并进 store。
 */
export function createZustandSignal<T, S>(store: ZustandStoreLike<T>, selector: (state: T) => S): () => S {
  const [value, setValue] = createSignal<S>(selector(store.getState()))
  // updater 形态：selector 结果可能是任意值（含函数），走 (prev) => next 重载避开
  // Solid setter 对「函数值」的排除分支。
  onCleanup(store.subscribe(state => setValue(() => selector(state))))
  return value
}
