import SolidMount from '../../host/SolidMount'
import type { AgentContextPanelProps } from './rightPanelTypes.ts'
export type { AgentContextPanelProps }

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface AgentContextPanelSolidModule {
  renderAgentContextPanel(container: HTMLElement, latest: () => AgentContextPanelProps): () => void
}

const modules = import.meta.glob<AgentContextPanelSolidModule>('./AgentContextPanel.solid.tsx', { eager: true })
const solidModule = modules['./AgentContextPanel.solid.tsx']
if (!solidModule) throw new Error('AgentContextPanel Solid 实体未进入 Vite module graph')

/**
 * AgentContextPanel — agent 右栏（W2-12，F2-F）。
 *
 * #515：实体在 AgentContextPanel.solid.tsx，本文件是 React 世界薄桥（批7 拆除）——
 * 插件注册表以 React lazy 组件消费本文件，桥进 Solid 实体。
 */
export default function AgentContextPanel(props: AgentContextPanelProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderAgentContextPanel(container, latest)} />
}
