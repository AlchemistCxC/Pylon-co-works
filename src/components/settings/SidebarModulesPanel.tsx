import SolidMount from '../../host/SolidMount'

/**
 * 侧栏模块显隐（设置 → 侧栏）。
 *
 * #515：实体已迁 `SidebarModulesPanel.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface SidebarModulesPanelProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface SidebarModulesPanelSolidModule {
  renderSidebarModulesPanel(container: HTMLElement, latest: () => SidebarModulesPanelProps): () => void
}

const modules = import.meta.glob<SidebarModulesPanelSolidModule>('./SidebarModulesPanel.solid.tsx', { eager: true })
const solidModule = modules['./SidebarModulesPanel.solid.tsx']
if (!solidModule) throw new Error('SidebarModulesPanel Solid 实体未进入 Vite module graph')

export default function SidebarModulesPanel(_props: SidebarModulesPanelProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderSidebarModulesPanel(container, latest)} />
}
