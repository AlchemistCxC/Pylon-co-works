import SolidMount from '../../host/SolidMount'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface SearchPanelSolidModule {
  renderSearchPanel(container: HTMLElement, latest: () => AgentSidebarContributionProps): () => void
}

const modules = import.meta.glob<SearchPanelSolidModule>('./SearchPanel.solid.tsx', { eager: true })
const solidModule = modules['./SearchPanel.solid.tsx']
if (!solidModule) throw new Error('SearchPanel Solid 实体未进入 Vite module graph')

/**
 * 搜索模块（VSCode 搜索侧栏那一类**专属工具面板**）。
 *
 * #515：实体在 SearchPanel.solid.tsx，本文件是 React 世界薄桥（批7 拆除）——
 * 插件注册表以 React lazy 组件消费本文件，桥进 Solid 实体。
 */
export default function SearchPanel(props: AgentSidebarContributionProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSearchPanel(container, latest)} />
}
