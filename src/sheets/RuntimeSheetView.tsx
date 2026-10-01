import SolidMount from '../host/SolidMount'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'

/**
 * RuntimeSheetView — 运行日志观察面（W1-08，§6 定稿）。
 *
 * list 回放 + pylon:runtime-log 增量（按 id 去重、固定上限）；左栏 source/level/search
 * 纯过滤；主区日志流 + clear；详情主区展开（无右栏）。unmount 清理 listener。
 *
 * #515：实体在 RuntimeSheetView.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface RuntimeSheetViewSolidModule {
  mountRuntimeSheetView(container: HTMLElement, latest: () => { sheet: SheetRecord; ctx: SheetContext }): () => void
}

const modules = import.meta.glob<RuntimeSheetViewSolidModule>('./RuntimeSheetView.solid.tsx', { eager: true })
const solidModule = modules['./RuntimeSheetView.solid.tsx']
if (!solidModule) throw new Error('RuntimeSheetView Solid 实体未进入 Vite module graph')

export default function RuntimeSheetView(props: { sheet: SheetRecord; ctx: SheetContext }) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.mountRuntimeSheetView(container, latest)} />
}
