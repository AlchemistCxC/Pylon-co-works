import SolidMount from '../../host/SolidMount'
import type { AgentContext } from '../../domains/agent/agentContext'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider, GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { FileTabRecord } from './fileSheetState.ts'

/** 与 Solid 实体（FileViewHost.solid.tsx）内声明的 FileViewHostProps 逐字段一致。 */
export interface FileViewHostProps {
  target?: WorkspaceTarget | null
  /** @deprecated direct component compatibility. */ source?: string | null
  fileProvider?: FileProvider | null
  gitProvider?: GitProvider | null
  context?: AgentContext | null
  tab: FileTabRecord | null
  onCloseTab: (key: string) => void
  onDirtyChange?: (key: string, dirty: boolean) => void
  onSavingChange?: (key: string, saving: boolean) => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface FileViewHostSolidModule {
  mountFileViewHost: (container: HTMLElement, latest: () => FileViewHostProps) => () => void
}

const modules = import.meta.glob<FileViewHostSolidModule>('./FileViewHost.solid.tsx', { eager: true })
const solidModule = modules['./FileViewHost.solid.tsx']
if (!solidModule) throw new Error('FileViewHost Solid 实体未进入 Vite module graph')

/**
 * FileViewHost — 主区统一 file/diff 宿主（ISSUE-08 D-03/D-04 + I08-A-FE-02 保存）。
 * #515：实体在 FileViewHost.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 * builtinFileWorkbench 注册的本 renderer（lazy import 本路径）经此桥继续工作。
 */
export default function FileViewHost(props: FileViewHostProps) {
  return <SolidMount initial={props} mount={solidModule.mountFileViewHost} />
}
