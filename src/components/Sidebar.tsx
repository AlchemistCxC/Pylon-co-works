import SolidMount from '../host/SolidMount'
import type { SheetContext } from '../workspace-sheets/sheetTypes'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface SidebarSolidModule {
  renderSidebar(container: HTMLElement, latest: () => SidebarProps): () => void
}

const modules = import.meta.glob<SidebarSolidModule>('./Sidebar.solid.tsx', { eager: true })
const solidModule = modules['./Sidebar.solid.tsx']
if (!solidModule) throw new Error('Sidebar Solid 实体未进入 Vite module graph')

/** 与 Solid 实体（Sidebar.solid.tsx）内声明的 SidebarProps 逐字段一致。 */
export interface SidebarProps {
  ctx: SheetContext
  state?: unknown
  sheet?: { id: string }
}

/**
 * Agent Sheet 左栏（有序模块栈；ADR-0011）。
 * #515：实体在 Sidebar.solid.tsx，本文件是 React 世界薄桥（批7 拆除）——
 * sidebarPrefsHooks / useBlockActionHandler 的订阅与注册语义已内联进实体，
 * 对应 React hook .ts 随批删除。
 */
export default function Sidebar(props: SidebarProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSidebar(container, latest)} />
}
