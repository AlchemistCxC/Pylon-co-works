import SolidMount from '../../host/SolidMount'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/** 与 Solid 实体（FileSheetView.solid.tsx）内声明的 FileSheetViewProps 逐字段一致。 */
export interface FileSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface FileSheetViewSolidModule {
  mountFileSheetView: (container: HTMLElement, latest: () => FileSheetViewProps) => () => void
}

const modules = import.meta.glob<FileSheetViewSolidModule>('./FileSheetView.solid.tsx', { eager: true })
const solidModule = modules['./FileSheetView.solid.tsx']
if (!solidModule) throw new Error('FileSheetView Solid 实体未进入 Vite module graph')

/**
 * FileSheetView — FileSheet 主视图（W2-03/04，D-08 VS Code 风格改造；ISSUE-08 D-02/D-04）。
 *
 * #515：实体在 FileSheetView.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 * sheet registry（builtinWorkspacePlugins 的 lazy import）经此桥继续工作；metadata
 * 承载 openTabs/activeFile/targetSessionId 的持久化契约不变。
 */
export default function FileSheetView(props: FileSheetViewProps) {
  return <SolidMount initial={props} mount={solidModule.mountFileSheetView} />
}
