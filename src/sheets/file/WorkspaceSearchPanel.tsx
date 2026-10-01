import SolidMount from '../../host/SolidMount'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/** 与 Solid 实体（WorkspaceSearchPanel.solid.tsx）内声明的同名接口逐字段一致。 */
export interface WorkspaceSearchPanelProps {
  target: WorkspaceTarget | null
  provider: FileProvider | null
  onOpenResult: (path: string, line: number) => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface WorkspaceSearchPanelSolidModule {
  mountWorkspaceSearchPanel: (container: HTMLElement, latest: () => WorkspaceSearchPanelProps) => () => void
}

const modules = import.meta.glob<WorkspaceSearchPanelSolidModule>('./WorkspaceSearchPanel.solid.tsx', { eager: true })
const solidModule = modules['./WorkspaceSearchPanel.solid.tsx']
if (!solidModule) throw new Error('WorkspaceSearchPanel Solid 实体未进入 Vite module graph')

/** WorkspaceSearchPanel — 工作区全文搜索与横向结果列表。#515：实体在 WorkspaceSearchPanel.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。 */
export default function WorkspaceSearchPanel(props: WorkspaceSearchPanelProps) {
  return <SolidMount initial={props} mount={solidModule.mountWorkspaceSearchPanel} />
}
