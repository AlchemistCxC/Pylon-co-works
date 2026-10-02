import SolidMount from '../../host/SolidMount'

/**
 * AgentConfigEditor — Agent 配置编辑入口（W1-07）。
 *
 * #515：实体已迁 `AgentConfigEditor.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface AgentConfigEditorProps {
  agentId: string
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface AgentConfigEditorSolidModule {
  renderAgentConfigEditor(container: HTMLElement, latest: () => AgentConfigEditorProps): () => void
}

const modules = import.meta.glob<AgentConfigEditorSolidModule>('./AgentConfigEditor.solid.tsx', { eager: true })
const solidModule = modules['./AgentConfigEditor.solid.tsx']
if (!solidModule) throw new Error('AgentConfigEditor Solid 实体未进入 Vite module graph')

export default function AgentConfigEditor(props: AgentConfigEditorProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderAgentConfigEditor(container, latest)} />
}
