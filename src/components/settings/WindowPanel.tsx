import SolidMount from '../../host/SolidMount'

/**
 * WindowSizeRow — 设置「窗口」组（窗口尺寸记忆/重置）。
 *
 * #515：实体已迁 `WindowPanel.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface WindowPanelProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface WindowPanelSolidModule {
  renderWindowPanel(container: HTMLElement, latest: () => WindowPanelProps): () => void
}

const modules = import.meta.glob<WindowPanelSolidModule>('./WindowPanel.solid.tsx', { eager: true })
const solidModule = modules['./WindowPanel.solid.tsx']
if (!solidModule) throw new Error('WindowPanel Solid 实体未进入 Vite module graph')

export default function WindowPanel(_props: WindowPanelProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderWindowPanel(container, latest)} />
}
