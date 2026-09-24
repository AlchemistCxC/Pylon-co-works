import SolidMount from '../SolidMount'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import type { AgentContext } from '../../agentContext'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/**
 * FileTabView — 文件视图（#279 第 2 梯队 Solid 化）。
 *
 * 本文件是宿主（FileViewHost）与 Solid 实体之间的**薄桥 + 加载缝**：实体在
 * `FileTabView.solid.tsx`（React 类型图不触碰 .solid 文件，P52 D4 同构，模块接口在此
 * 声明）。props 全量经 SolidMount 响应式通道透传——saveReceipt/saveAnchorToken/
 * editing 等可变字段的响应性是保存锚点/脏判定的数据完整性契约。
 */

export interface FileSaveReceipt {
  version: number
  expectedContent: string
  persistedContent: string
}

export interface FileTabViewProps {
  target?: WorkspaceTarget | null
  /** @deprecated direct component compatibility. */ source?: string | null
  provider?: FileProvider | null
  path: string
  revealLine?: number
  context?: AgentContext | null
  editing?: boolean
  onTruncated: (truncated: boolean) => void
  onContentReady?: (content: string) => void
  onContentChange?: (content: string) => void
  onExternalChange?: () => void
  onSelectionChange?: (selection: DispatchSelection | null) => void
  onSelectionInvalidated?: () => void
  onSave?: () => void
  saveAnchorToken?: number
  saveReceipt?: FileSaveReceipt | null
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface FileTabSolidModule {
  renderFileTabView(container: HTMLElement, latest: () => FileTabViewProps): () => void
}

const modules = import.meta.glob<FileTabSolidModule>('./FileTabView.solid.tsx', { eager: true })
const solidModule = modules['./FileTabView.solid.tsx']
if (!solidModule) throw new Error('FileTab Solid 实体未进入 Vite module graph')

export default function FileTabView(props: FileTabViewProps) {
  return (
    <SolidMount
      initial={props}
      mount={(container, latest) => solidModule.renderFileTabView(container, latest)}
    />
  )
}
