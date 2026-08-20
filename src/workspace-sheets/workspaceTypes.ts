import type { ComponentType } from 'react'
import type { SheetContext, SheetInput, SheetRecord, SidebarMode } from './sheetTypes.ts'

export interface WorkspaceLaunchOption {
  kind: string
  title: string
  description: string
  launchable: boolean
  /** Host 解释的稳定图标键；未知键降级为通用 Workspace 图标。 */
  icon?: string
  /** 插件自有的分组键与用户可见标题；未声明时进入“其他”。 */
  category?: string
  categoryLabel?: string
  categoryOrder?: number
  /** 同一分类内的局部顺序；不形成跨插件视觉 token。 */
  order?: number
  keywords?: readonly string[]
}

export interface WorkspaceViewProps<TState = unknown> {
  sheet: SheetRecord
  ctx: SheetContext
  state: TState
}

/** 阶段 6 Workspace 动态类型完整契约：元数据、渲染与状态编解码同一生命周期。 */
export interface WorkspaceTypeDefinition<TState = unknown> {
  kind: string
  label: string
  singleton: boolean
  getSingletonKey: (input: Pick<SheetInput, 'agentId' | 'singletonKey' | 'metadata'>) => string | undefined
  sidebarMode: SidebarMode
  launch?: WorkspaceLaunchOption
  component: ComponentType<WorkspaceViewProps<TState>>
  sidebar?: ComponentType<WorkspaceViewProps<TState>>
  contextPanel?: 'none' | ComponentType<WorkspaceViewProps<TState>>
  createInitialState(input?: unknown): TState
  serialize(state: TState): unknown
  deserialize(raw: unknown): TState
  canClose?(state: TState): boolean | Promise<boolean>
}

/** 兼容阶段 6 前两切片的命名；不再是 metadata-only。 */
export type WorkspaceDescriptor<TState = unknown> = WorkspaceTypeDefinition<TState>
