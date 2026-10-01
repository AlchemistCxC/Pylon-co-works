import SolidMount from '../../host/SolidMount'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/** 与 Solid 实体（GatewaySheetView.solid.tsx）内声明的 GatewaySheetViewProps 逐字段一致。 */
export interface GatewaySheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface GatewaySheetViewSolidModule {
  mountGatewaySheetView: (container: HTMLElement, latest: () => GatewaySheetViewProps) => () => void
}

const modules = import.meta.glob<GatewaySheetViewSolidModule>('./GatewaySheetView.solid.tsx', { eager: true })
const solidModule = modules['./GatewaySheetView.solid.tsx']
if (!solidModule) throw new Error('GatewaySheetView Solid 实体未进入 Vite module graph')

/**
 * GatewaySheetView — 网关平台概览（W3-01）+ 实例管理（I12-W5）+ 交互优化（P79）
 * + 视觉美化（P82）。
 * #515：实体在 GatewaySheetView.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function GatewaySheetView(props: GatewaySheetViewProps) {
  return <SolidMount initial={props} mount={solidModule.mountGatewaySheetView} />
}
