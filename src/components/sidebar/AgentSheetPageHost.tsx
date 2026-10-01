import SolidMount from '../../host/SolidMount'
import { useOpenSidebarPage } from './useOpenSidebarPage.ts'
import type { AgentSheetPageHostProps } from './sidebarBridgeTypes.ts'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface AgentSheetPageHostSolidModule {
  renderAgentSheetPageHost(container: HTMLElement, latest: () => AgentSheetPageHostProps): () => void
}

const modules = import.meta.glob<AgentSheetPageHostSolidModule>('./AgentSheetPageHost.solid.tsx', { eager: true })
const solidModule = modules['./AgentSheetPageHost.solid.tsx']
if (!solidModule) throw new Error('AgentSheetPageHost Solid 实体未进入 Vite module graph')

export { useOpenSidebarPage }

/**
 * 主区整页宿主：把声明了 `page` 的左栏区块内容展开成 AgentSheet 的整页。
 *
 * **不是新 Sheet**——它替换当前 Sheet 的聊天视图，左栏仍是该 Sheet 的左栏。
 *
 * #515：实体在 AgentSheetPageHost.solid.tsx（插件贡献体经 React 岛渲染），本文件是
 * React 世界薄桥（批7 拆除）；`useOpenSidebarPage` 是 React hook（消费方
 * sheets/AgentSheetView.tsx 本轮未迁），正身抽到 useOpenSidebarPage.ts 由两侧共享。
 */
export default function AgentSheetPageHost(props: AgentSheetPageHostProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderAgentSheetPageHost(container, latest)} />
}
