import SolidMount from '../sheets/SolidMount'
import type { SheetRecord } from './sheetTypes'
import type { AgentStatus } from '../components/settings/agentTypes'

/**
 * SheetTabStrip — 页签条（#279 第 3 梯队 Solid 化）。
 *
 * 本文件是 SheetLayout（React）与 Solid 实体之间的**薄桥 + 加载缝**：实体在
 * `SheetTabStrip.solid.tsx`（React 类型图不触碰 .solid 文件，P52 D4 同构，模块接口
 * 在此声明）。sheets/activeSheetId 等可变 props 经 SolidMount 响应式通道透传。
 */

export interface WorkspaceMenuActions {
  onTogglePin: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  onReopen: () => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface SheetTabStripSolidModule {
  renderSheetTabStrip(container: HTMLElement, latest: () => SheetTabStripProps): () => void
}

export interface SheetTabStripProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  agentStatuses?: Record<string, AgentStatus>
  onFocus: (id: string) => void
  onClose: (id: string) => void
  menuActions: WorkspaceMenuActions
  canReopen: boolean
}

const modules = import.meta.glob<SheetTabStripSolidModule>('./SheetTabStrip.solid.tsx', { eager: true })
const solidModule = modules['./SheetTabStrip.solid.tsx']
if (!solidModule) throw new Error('SheetTabStrip Solid 实体未进入 Vite module graph')

export default function SheetTabStrip(props: SheetTabStripProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSheetTabStrip(container, latest)} />
}
