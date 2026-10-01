import SolidMount from '../../host/SolidMount'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface SessionsPanelSolidModule {
  renderSessionsPanel(container: HTMLElement, latest: () => AgentSidebarContributionProps): () => void
}

const modules = import.meta.glob<SessionsPanelSolidModule>('./SessionsPanel.solid.tsx', { eager: true })
const solidModule = modules['./SessionsPanel.solid.tsx']
if (!solidModule) throw new Error('SessionsPanel Solid 实体未进入 Vite module graph')

/**
 * 会话区块。一个区块同时承载两个族群，按 cwd 分组。
 *
 * 本组件**不画区块头**——标题、折叠钮、头部动作都由宿主渲染（见 `Sidebar.tsx`）。
 *
 * #515：实体在 SessionsPanel.solid.tsx，本文件是 React 世界薄桥（批7 拆除）——
 * 插件注册表以 React lazy 组件消费本文件，桥进 Solid 实体。
 */
export default function SessionsPanel(props: AgentSidebarContributionProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSessionsPanel(container, latest)} />
}
