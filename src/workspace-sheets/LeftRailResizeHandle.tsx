import SolidMount from '../host/SolidMount'

/**
 * LeftRailResizeHandle — 左栏拖拽实时调宽（#154，#279 第 3 梯队 Solid 化）。
 *
 * 本文件是 SheetLayout（React）与 Solid 实体之间的**薄桥 + 加载缝**：实体在
 * `LeftRailResizeHandle.solid.tsx`（React 类型图不触碰 .solid 文件，P52 D4 同构）。
 * 组件无 props；宽度状态走 zustand store（Solid 侧经订阅信号消费），落库事务不变。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface LeftRailResizeHandleSolidModule {
  renderLeftRailResizeHandle(container: HTMLElement): () => void
}

const modules = import.meta.glob<LeftRailResizeHandleSolidModule>('./LeftRailResizeHandle.solid.tsx', { eager: true })
const solidModule = modules['./LeftRailResizeHandle.solid.tsx']
if (!solidModule) throw new Error('LeftRailResizeHandle Solid 实体未进入 Vite module graph')

export default function LeftRailResizeHandle() {
  return <SolidMount initial={{}} mount={container => solidModule.renderLeftRailResizeHandle(container)} />
}
