import SolidMount from '../../host/SolidMount'
import type { MessageSearchBarProps } from './rightPanelTypes.ts'
export type { MessageSearchBarProps }

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface MessageSearchBarSolidModule {
  renderMessageSearchBar(container: HTMLElement, latest: () => MessageSearchBarProps): () => void
}

const modules = import.meta.glob<MessageSearchBarSolidModule>('./MessageSearchBar.solid.tsx', { eager: true })
const solidModule = modules['./MessageSearchBar.solid.tsx']
if (!solidModule) throw new Error('MessageSearchBar Solid 实体未进入 Vite module graph')

/**
 * 消息搜索条（AgentContextPanel 的搜索输入行）。
 *
 * #515：实体在 MessageSearchBar.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function MessageSearchBar(props: MessageSearchBarProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderMessageSearchBar(container, latest)} />
}
