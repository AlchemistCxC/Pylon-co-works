import SolidMount from '../SolidMount'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * SearchSheetView — 跨会话快照搜索（W3-03，#279 第 1 梯队 Solid 化）。
 *
 * 本文件是 sheet 注册表契约（React lazy 组件）与 Solid 实体之间的**薄桥 + 加载缝**：
 * 实体在 `SearchSheetView.solid.tsx`，经 eager glob 引入——React 类型图不触碰 .solid
 * 文件（P52 D4 同构，模块接口在此声明），Solid JSX 只出现在 solid 编译管线的文件里。
 * props 按挂载捕获（sheet/ctx 由布局层按挂载稳定提供，见 SolidMount 契约）。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface SearchSheetSolidModule {
  renderSearchSheetView(container: HTMLElement, props: { sheet: SheetRecord; ctx: SheetContext }): () => void
}

const modules = import.meta.glob<SearchSheetSolidModule>('./SearchSheetView.solid.tsx', { eager: true })
const solidModule = modules['./SearchSheetView.solid.tsx']
if (!solidModule) throw new Error('Search Solid 实体未进入 Vite module graph')

export default function SearchSheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  return <SolidMount mount={container => solidModule.renderSearchSheetView(container, { sheet, ctx })} />
}
