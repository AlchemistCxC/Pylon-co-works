import SolidMount from '../../host/SolidMount'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/** 与 Solid 实体（DocsSheetView.solid.tsx）内声明的 DocsSheetViewProps 逐字段一致。 */
export interface DocsSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface DocsSheetViewSolidModule {
  mountDocsSheetView: (container: HTMLElement, latest: () => DocsSheetViewProps) => () => void
}

const modules = import.meta.glob<DocsSheetViewSolidModule>('./DocsSheetView.solid.tsx', { eager: true })
const solidModule = modules['./DocsSheetView.solid.tsx']
if (!solidModule) throw new Error('DocsSheetView Solid 实体未进入 Vite module graph')

/**
 * DocsSheetView — 离线文档站壳（#371）。
 *
 * 子 WebView 由后端创建并嵌进 viewport（`pylon-docs://` scheme），前端只做三件事：
 * 进入活动主区自动 start（keep-alive 复活为幂等）、bounds/可见性随布局与覆盖层同步、
 * 卸载时 close 回收 WebView2 子进程。导航 chrome 保持最小（回首页/后退/前进/刷新）——
 * VitePress 自带 navbar/sidebar/搜索，不复制浏览器语义。
 *
 * 原生子 WebView 是独立于 React DOM 的窗口：display:none 盖不住它，可见性必须走
 * docs_sheet_set_visible（与 Browser Sheet 同一约束）；外链在 Rust on_navigation
 * fail-closed 取消，壳层不代开系统浏览器。
 *
 * #515：实体在 DocsSheetView.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function DocsSheetView(props: DocsSheetViewProps) {
  return <SolidMount initial={props} mount={solidModule.mountDocsSheetView} />
}
