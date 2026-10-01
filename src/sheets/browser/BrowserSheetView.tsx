import SolidMount from '../../host/SolidMount'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/** 与 Solid 实体（BrowserSheetView.solid.tsx）内声明的 props 逐字段一致。 */
export interface BrowserSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface BrowserSheetViewSolidModule {
  mountBrowserSheetView: (container: HTMLElement, latest: () => BrowserSheetViewProps) => () => void
}

const modules = import.meta.glob<BrowserSheetViewSolidModule>('./BrowserSheetView.solid.tsx', { eager: true })
const solidModule = modules['./BrowserSheetView.solid.tsx']
if (!solidModule) throw new Error('BrowserSheetView Solid 实体未进入 Vite module graph')

/**
 * BrowserSheetView — browser 壳（W4-03）。
 *
 * 纯状态机 idle/starting/ready/error + WebView bounds/导航控制；子 WebView 由后端创建并嵌入 viewport。
 * Sheet 卸载时调用 browser_close，确保 WebView2 子进程随 sheet 生命周期回收。
 *
 * #515：实体在 BrowserSheetView.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function BrowserSheetView(props: BrowserSheetViewProps) {
  return <SolidMount initial={props} mount={solidModule.mountBrowserSheetView} />
}
