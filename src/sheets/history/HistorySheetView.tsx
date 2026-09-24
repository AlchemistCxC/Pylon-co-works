import SolidMount from '../SolidMount'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * HistorySheetView — 存档会话列表 + 导出 + 回放入口（#279 第 1 梯队 Solid 化）。
 *
 * 本文件是 sheet 注册表契约（React lazy 组件）与 Solid 实体之间的**薄桥 + 加载缝**：
 * 实体在 `HistorySheetView.solid.tsx`，经 eager glob 引入——React 类型图不触碰 .solid
 * 文件（P52 D4 同构，模块接口在此声明），Solid JSX 只出现在 solid 编译管线的文件里。
 * props 按挂载捕获（sheet/ctx 由布局层按挂载稳定提供，见 SolidMount 契约）。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface HistorySheetSolidModule {
  renderHistorySheetView(container: HTMLElement, props: { sheet: SheetRecord; ctx: SheetContext }): () => void
}

const modules = import.meta.glob<HistorySheetSolidModule>('./HistorySheetView.solid.tsx', { eager: true })
const solidModule = modules['./HistorySheetView.solid.tsx']
if (!solidModule) throw new Error('History Solid 实体未进入 Vite module graph')

export default function HistorySheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  return <SolidMount initial={{ sheet, ctx }} mount={(container, getProps) => solidModule.renderHistorySheetView(container, getProps())} />
}
