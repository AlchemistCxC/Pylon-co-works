import SolidMount from '../../host/SolidMount'
import type { ContextPanelHostProps } from './rightPanelTypes.ts'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface ContextPanelHostSolidModule {
  renderContextPanelHost(container: HTMLElement, latest: () => ContextPanelHostProps): () => void
}

const modules = import.meta.glob<ContextPanelHostSolidModule>('./ContextPanelHost.solid.tsx', { eager: true })
const solidModule = modules['./ContextPanelHost.solid.tsx']
if (!solidModule) throw new Error('ContextPanelHost Solid 实体未进入 Vite module graph')

/**
 * 右栏面板宿主（切换器 + 激活面板渲染）。
 *
 * #515：实体在 ContextPanelHost.solid.tsx（插件贡献体经 React 岛渲染），本文件是
 * React 世界薄桥（批7 拆除）。
 */
export default function ContextPanelHost(props: ContextPanelHostProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderContextPanelHost(container, latest)} />
}
