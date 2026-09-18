import type { ComponentType, LazyExoticComponent } from 'react'
import type { RegistryEntry } from '../registry/types.ts'

/** Slots owned by the application shell. Plugins may contribute to these slots,
 * but never replace native window controls or the drag-region boundary.
 *
 * `app-menu` 是唯一**数据化**的槽：它不渲染成标题栏上的按钮，而是成为设置齿轮菜单里的一项
 * （见 `CommandTitlebarContribution`）。 */
export type TitlebarSlot = 'left-rail' | 'workspace' | 'center' | 'app-actions' | 'app-menu'

export interface TitlebarContext {
  readonly interfaceMode: string
  readonly workspaceKind?: string
  readonly sheetId: string | null
  readonly settingsOpen: boolean
}

interface TitlebarContributionBase {
  readonly id: string
  readonly slot: TitlebarSlot
  readonly label: string
  readonly order?: number
  readonly when?: (context: TitlebarContext) => boolean
  readonly commandId?: string
  readonly widthBehavior?: 'fixed' | 'shrink' | 'overflow-menu'
}

export interface FirstPartyTitlebarContribution extends TitlebarContributionBase {
  readonly renderKind: 'first-party-react'
  readonly component: ComponentType<{ context: TitlebarContext }> | LazyExoticComponent<ComponentType<{ context: TitlebarContext }>>
}

export interface IsolatedTitlebarContribution extends TitlebarContributionBase {
  readonly renderKind: 'isolated-surface'
  readonly surfaceId: string
}

/**
 * 设置齿轮菜单里的一项（API 2.1 新增）。
 *
 * **只有数据，没有渲染**：菜单外壳（图标、标题、分组、键盘导航）全部归宿主，与左栏模块同一条
 * 纪律——插件只声明「叫什么、什么图标、点了跑哪条命令」。点击时宿主执行 `commandId`（命令注册表），
 * 因此插件不必自己持有菜单的 DOM，也不必知道菜单长什么样。
 */
export interface CommandTitlebarContribution extends TitlebarContributionBase {
  readonly slot: 'app-menu'
  readonly renderKind: 'command'
  readonly commandId: string
  /** 稳定图标键；与左栏模块图标同一映射（未知键安全降级为无图标）。 */
  readonly icon?: string
}

export type TitlebarContribution = FirstPartyTitlebarContribution | IsolatedTitlebarContribution | CommandTitlebarContribution
export type TitlebarRegistryEntry = RegistryEntry<TitlebarContribution>
