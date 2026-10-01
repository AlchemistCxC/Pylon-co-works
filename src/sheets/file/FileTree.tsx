import SolidMount from '../../host/SolidMount'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/**
 * FileTree — 懒加载、可双向折叠的工作区文件树。
 *
 * 已加载子树保留在内存，折叠只隐藏 descendants；再次展开不重复请求。缩进封顶并强制
 * label ellipsis，深层目录不会撑宽 FileSheet 左栏。
 */

/** 与 Solid 实体（FileTree.solid.tsx）内声明的 FileTreeProps 逐字段一致。 */
export interface FileTreeProps {
  target: WorkspaceTarget | null
  provider: FileProvider | null
  activeFile: string | null
  onOpen: (path: string) => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface FileTreeSolidModule {
  mountFileTree: (container: HTMLElement, latest: () => FileTreeProps) => () => void
}

const modules = import.meta.glob<FileTreeSolidModule>('./FileTree.solid.tsx', { eager: true })
const solidModule = modules['./FileTree.solid.tsx']
if (!solidModule) throw new Error('FileTree Solid 实体未进入 Vite module graph')

/** #515：实体在 FileTree.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。 */
export default function FileTree(props: FileTreeProps) {
  return <SolidMount initial={props} mount={solidModule.mountFileTree} />
}
