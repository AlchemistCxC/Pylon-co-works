import { createSignal, onCleanup } from 'solid-js'
import type { ZustandStoreLike } from './solidStoreKernel.ts'

export type { ZustandStoreLike }

/**
 * 通知式 store → Solid 只读信号（组件侧响应式读取原语，在役）。
 *
 * 订阅随 Solid owner（组件/effect 根）自动回收；selector 语义与旧 React 侧
 * `useXxxStore(selector)` 一致。信号默认按引用判等——内核状态切片在未变时
 * 引用稳定，不会产生多余的通知。
 * 终态：zustand 库与 React shim 均已退役（#515 W3），`useXxxStore` 即
 * SolidStoreKernel 对象，其 getState/subscribe 门面天然满足 `ZustandStoreLike`
 * （单源于 solidStoreKernel，本文件 re-export）——组件读 store 切片统一走本函数，
 * 没有删除后续步骤（名字里的 zustand 仅为历史沿革；#520 R3 自 host 迁居
 * infrastructure/state）。
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
