import SolidMount from '../../host/SolidMount'
import type { AgentContext } from '../../domains/agent/agentContext'

/** 与 Solid 实体（ViewsPanel.solid.tsx）内声明的 ViewsPanelProps 逐字段一致。 */
export interface ViewsPanelProps {
  source: string | null
  context?: AgentContext | null
  onOpenFile: (path: string) => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface ViewsPanelSolidModule {
  mountViewsPanel: (container: HTMLElement, latest: () => ViewsPanelProps) => () => void
}

const modules = import.meta.glob<ViewsPanelSolidModule>('./ViewsPanel.solid.tsx', { eager: true })
const solidModule = modules['./ViewsPanel.solid.tsx']
if (!solidModule) throw new Error('ViewsPanel Solid 实体未进入 Vite module graph')

/**
 * ViewsPanel — FileSheet 的 Agent 文件活动工作面（ISSUE-08 D-04）。
 * #515：实体在 ViewsPanel.solid.tsx（`formatTouchTime` 一并随迁），本文件是 React 世界
 * 薄桥（批7 拆除）。
 */
export default function ViewsPanel(props: ViewsPanelProps) {
  return <SolidMount initial={props} mount={solidModule.mountViewsPanel} />
}
