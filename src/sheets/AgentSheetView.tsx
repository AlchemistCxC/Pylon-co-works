import SolidMount from '../host/SolidMount'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'

/** 与 Solid 实体（AgentSheetView.solid.tsx）内声明的 AgentSheetViewProps 逐字段一致。 */
export interface AgentSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface AgentSheetViewSolidModule {
  mountAgentSheetView: (container: HTMLElement, latest: () => AgentSheetViewProps) => () => void
}

const modules = import.meta.glob<AgentSheetViewSolidModule>('./AgentSheetView.solid.tsx', { eager: true })
const solidModule = modules['./AgentSheetView.solid.tsx']
if (!solidModule) throw new Error('AgentSheetView Solid 实体未进入 Vite module graph')

/**
 * AgentSheetView — agent 主工作台（W1-03 侧栏上移后只留主区）。
 *
 * 侧栏已上移 SheetLayout（entry.sidebar → SheetSidebarSlot）；本组件只渲染主区
 * （Solid Renderer Suite + 右栏宿主），props 收敛为 { sheet, ctx }。
 *
 * W4-02（姿态二拍板）：历史回放以「只读姿态」直接进入本 sheet——Solid Workbench
 * 经现成 lifecycle 恢复消息，但输入宿主隐藏，改渲染「只读回放 · 点击继续」占位条；
 * 点击 clear 姿态 → ControlCenter 出现 → 首次 send 即 live。姿态是一次性手势：
 * 离开该会话/关闭 sheet 即清除，防 tab 重开误回只读。
 *
 * #515：实体在 AgentSheetView.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 * 翻转前 deferral（三分支 React 岛 + rendererMode 门禁冲突）已随工作台实体 Solid 化
 * 解除：岛链退化为 solid-in-solid，仅整页宿主/隔离表面两分支仍是 React 面。
 */
export default function AgentSheetView(props: AgentSheetViewProps) {
  return <SolidMount initial={props} mount={solidModule.mountAgentSheetView} />
}
