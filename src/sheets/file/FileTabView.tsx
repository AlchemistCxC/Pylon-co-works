import SolidMount from '../SolidMount'
import type { AgentContext } from '../../agentContext'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { FileCodeEditorApi, KernelSummary } from './FileCodeEditor.tsx'

/**
 * FileTabView — 文件视图（#279 第 2 梯队 Solid 化 + 0-A1~A3 语义合并重移植）。
 *
 * 本文件是宿主（FileViewHost）与 Solid 实体之间的**薄桥 + 加载缝**：实体在
 * `FileTabView.solid.tsx`（React 类型图不触碰 .solid 文件，P52 D4 同构，模块接口在此
 * 声明）。props 全量经 SolidMount 响应式通道透传——saveReceipt/saveAnchorToken/
 * writable/baseline 等可变字段的响应性是保存锚点/脏判定的数据完整性契约。
 *
 * props 契约 = 0-A1~A3 语义（合并重移植）：默认可写（writable，仅物理例外 false）、
 * KernelSummary/apiRef 内核句柄面、onWriteLockChange 写冲突锁。实体行为规格见
 * FileTabView.solid.tsx 头注与 `.agents/records/280-filesheet-stage0-dev-record.md`。
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
  /** 0-A2 默认可写：仅物理例外（truncated）传 false → 内核只读档。 */
  writable?: boolean
  /** 磁盘锚点（宿主持有；保存回执/重载后推进），透传内核计算 dirty。 */
  baseline?: string
  /** 0-A4：truncated 时携带体积信息（>1MB 降级提示条）。 */
  onTruncated: (truncated: boolean, info?: { totalBytes: number }) => void
  onContentReady?: (content: string) => void
  onExternalChange?: () => void
  onSelectionInvalidated?: () => void
  onSummaryChange?: (summary: KernelSummary) => void
  /** 0-A3 写冲突锁：agent 写盘冷却期置 true，静默后置 false。 */
  onWriteLockChange?: (locked: boolean) => void
  onSave?: () => void
  saveAnchorToken?: number
  saveReceipt?: FileSaveReceipt | null
  apiRef?: { current: FileCodeEditorApi | null }
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface FileTabSolidModule {
  renderFileTabView(container: HTMLElement, latest: () => FileTabViewProps): () => void
}

const modules = import.meta.glob<FileTabSolidModule>('./FileTabView.solid.tsx', { eager: true })
const solidModule = modules['./FileTabView.solid.tsx']
if (!solidModule) throw new Error('FileTab Solid 实体未进入 Vite module graph')

export type { FileCodeEditorApi, KernelSummary }

export default function FileTabView(props: FileTabViewProps) {
  return (
    <SolidMount
      initial={props}
      mount={(container, latest) => solidModule.renderFileTabView(container, latest)}
    />
  )
}
