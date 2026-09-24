import SolidMount from '../sheets/SolidMount'
import type { SheetRecord } from './sheetTypes'
import type { InterfaceMode } from '../domains/interface/interfaceModeStore.ts'
import type { InterfaceModeChromeStyle } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import type { SettingsDomainId } from '../settingsDomains.ts'

/**
 * WorkspaceTitlebar — 标题栏（#279 第 3 梯队 Solid 化）。
 *
 * 本文件是 App（React）与 Solid 实体之间的**薄桥 + 加载缝**：实体在
 * `WorkspaceTitlebar.solid.tsx`（React 类型图不触碰 .solid 文件，P52 D4 同构，模块接口
 * 在此声明）。实体内的插件贡献簇（app-actions，按插件 API 是 React 组件）经
 * `WorkspaceTitlebarPluginIsland`（React 岛）渲染——React 生态只剩这一处插件面。
 * sheets/activeSheetId/sidebarCollapsed 等可变 props 经 SolidMount 响应式通道透传。
 */

export interface WorkspaceMenuActions {
  onTogglePin: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  onReopen: () => void
}

export interface WorkspaceTitlebarProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  activeSheetKind?: string
  activeSessionId?: string | null
  sidebarCollapsed: boolean
  /** active Sheet 是否真的会渲染左栏；无左栏时左格不占轨道、折叠按钮不出现。 */
  sidebarEnabled: boolean
  rightPanelEnabled?: boolean
  onToggleSidebar: () => void
  onFocusSheet: (id: string) => void
  onCloseSheet: (id: string) => void
  menuActions: WorkspaceMenuActions
  onOpenSheet: () => void
  onToggleRightPanel: () => void
  /** Open Settings directly at one of the four top-level domains：齿轮菜单里设置域项的唯一去处（幂等开/聚焦，ADR-0013）。 */
  onOpenSettingsDomain: (domain: SettingsDomainId) => void
  interfaceMode?: InterfaceMode
  chromeStyle?: InterfaceModeChromeStyle
  quickSwitchLabel?: string
  onToggleInterfaceMode?: () => void
  onMinimize(event: unknown): void
  onToggleFullscreen(event: unknown): void
  onCloseWindow(event: unknown): void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface WorkspaceTitlebarSolidModule {
  renderWorkspaceTitlebar(container: HTMLElement, latest: () => WorkspaceTitlebarProps): () => void
}

const modules = import.meta.glob<WorkspaceTitlebarSolidModule>('./WorkspaceTitlebar.solid.tsx', { eager: true })
const solidModule = modules['./WorkspaceTitlebar.solid.tsx']
if (!solidModule) throw new Error('WorkspaceTitlebar Solid 实体未进入 Vite module graph')

export default function WorkspaceTitlebar(props: WorkspaceTitlebarProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderWorkspaceTitlebar(container, latest)} />
}
