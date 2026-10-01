import SolidMount from '../host/SolidMount'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'

/**
 * OverviewSheetView — 启动选择器（W1-05/06，§5.1）。
 *
 * 虚拟空态（不写入持久 sheet 数组）：无 active sheet 时 SheetLayout 直接渲染 overview。
 *
 * #515：实体在 OverviewSheetView.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 * ctx 回调与 store 状态经 SolidMount 响应式通道透传。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface OverviewSheetViewSolidModule {
  mountOverviewSheetView(container: HTMLElement, latest: () => { sheet: SheetRecord; ctx: SheetContext }): () => void
}

const modules = import.meta.glob<OverviewSheetViewSolidModule>('./OverviewSheetView.solid.tsx', { eager: true })
const solidModule = modules['./OverviewSheetView.solid.tsx']
if (!solidModule) throw new Error('OverviewSheetView Solid 实体未进入 Vite module graph')

export default function OverviewSheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  return <SolidMount initial={{ sheet, ctx }} mount={(container, latest) => solidModule.mountOverviewSheetView(container, latest)} />
}
