import SolidMount from '../../host/SolidMount'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/** 与 Solid 实体（DiffView.solid.tsx）内声明的 DiffViewProps 逐字段一致。 */
export interface DiffViewProps {
  target: WorkspaceTarget | null
  provider: GitProvider | null
  path: string
  staged: boolean
  onClose: () => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface DiffViewSolidModule {
  mountDiffView: (container: HTMLElement, latest: () => DiffViewProps) => () => void
}

const modules = import.meta.glob<DiffViewSolidModule>('./DiffView.solid.tsx', { eager: true })
const solidModule = modules['./DiffView.solid.tsx']
if (!solidModule) throw new Error('DiffView Solid 实体未进入 Vite module graph')

/**
 * DiffView — Git diff 展示（W2-05）。
 *
 * 点击 staged/unstaged 条目 → git_diff(source, path, staged) → 复用 DiffCard
 * （DiffPayload 统一渲染，不新造 diff 渲染器）。只读。
 * #515：实体在 DiffView.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function DiffView(props: DiffViewProps) {
  return <SolidMount initial={props} mount={solidModule.mountDiffView} />
}
