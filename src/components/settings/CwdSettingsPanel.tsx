import SolidMount from '../../host/SolidMount'
import type { Workspace } from '../../domains/workspace/workspaceEntities'

/**
 * CwdSettingsPanel — 工作区（cwd）设置面板。
 *
 * 职责：
 * - skills / MCP 选择的编辑与保存；
 * - MCP 选项来自 agent 级暴露列表（get_mcp_servers）。
 *
 * #515：实体已迁 `CwdSettingsPanel.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface CwdSettingsPanelProps {
  workspace: Workspace
  onClose: () => void
  showHeader?: boolean
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface CwdSettingsPanelSolidModule {
  renderCwdSettingsPanel(container: HTMLElement, latest: () => CwdSettingsPanelProps): () => void
}

const modules = import.meta.glob<CwdSettingsPanelSolidModule>('./CwdSettingsPanel.solid.tsx', { eager: true })
const solidModule = modules['./CwdSettingsPanel.solid.tsx']
if (!solidModule) throw new Error('CwdSettingsPanel Solid 实体未进入 Vite module graph')

export default function CwdSettingsPanel(props: CwdSettingsPanelProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderCwdSettingsPanel(container, latest)} />
}
