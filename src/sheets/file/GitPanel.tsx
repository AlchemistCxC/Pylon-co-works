import SolidMount from '../../host/SolidMount'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/** 与 Solid 实体（GitPanel.solid.tsx）内声明的 GitPanelProps 逐字段一致。 */
export interface GitPanelProps {
  target: WorkspaceTarget | null
  provider: GitProvider | null
  onOpenDiff: (path: string, staged: boolean) => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface GitPanelSolidModule {
  mountGitPanel: (container: HTMLElement, latest: () => GitPanelProps) => () => void
}

const modules = import.meta.glob<GitPanelSolidModule>('./GitPanel.solid.tsx', { eager: true })
const solidModule = modules['./GitPanel.solid.tsx']
if (!solidModule) throw new Error('GitPanel Solid 实体未进入 Vite module graph')

/** GitPanel — 完整 Git 树、状态和提交历史。#515：实体在 GitPanel.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。 */
export default function GitPanel(props: GitPanelProps) {
  return <SolidMount initial={props} mount={solidModule.mountGitPanel} />
}
