import SolidMount from '../../host/SolidMount'
import type { AgentContext } from '../../domains/agent/agentContext'

/**
 * ConfigOptionsPanel — 会话动态配置选项面板。
 *
 * #515：实体已迁 `ConfigOptionsPanel.solid.tsx`，本文件是 React 世界薄桥（批7 拆除），
 * open 面经 SolidMount 响应式通道透传。
 */

export interface ConfigOptionsPanelProps {
  context?: AgentContext
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface ConfigOptionsPanelSolidModule {
  renderConfigOptionsPanel(container: HTMLElement, latest: () => ConfigOptionsPanelProps): () => void
}

const modules = import.meta.glob<ConfigOptionsPanelSolidModule>('./ConfigOptionsPanel.solid.tsx', { eager: true })
const solidModule = modules['./ConfigOptionsPanel.solid.tsx']
if (!solidModule) throw new Error('ConfigOptionsPanel Solid 实体未进入 Vite module graph')

export default function ConfigOptionsPanel(props: ConfigOptionsPanelProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderConfigOptionsPanel(container, latest)} />
}
