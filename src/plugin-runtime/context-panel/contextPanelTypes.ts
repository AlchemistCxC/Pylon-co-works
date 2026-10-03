import type { Component } from 'solid-js'
import type { RegistryEntry } from '../registry/types.ts'
import type { SheetContext, SheetRecord } from '../../contracts/sheets.ts'
import type { SettingsSchema, SettingsValueAdapter } from '../renderers/rendererSettingsTypes.ts'

export interface ContextPanelContributionContext {
  readonly workspaceKind?: string
  readonly sheetId: string | null
  readonly activeSessionId: string | null
  readonly activeAgent?: string
}

/** Context supplied by the application shell. A panel may be global (no Sheet)
 * or contextual (filtered by workspaceKind/sheetId). */
export type ShellContext = ContextPanelContributionContext

export interface ContextPanelSettingsContribution {
  readonly id: string
  readonly label: string
  readonly description?: string
  /** Optional canonical Settings section; defaults to the right-rail section. */
  readonly section?: 'right' | 'pluginManager'
  /** Existing PluginSettingsPage contribution to open when selected. */
  readonly pageId?: string
}

export interface ContextPanelContributionProps {
  readonly sheet: SheetRecord
  readonly ctx: SheetContext
}

interface ContextPanelContributionBase {
  readonly id: string
  readonly workspaceKind?: string
  readonly label: string
  readonly icon?: string
  readonly order?: number
  readonly scope?: 'global' | 'contextual'
  readonly placement?: 'right-rail' | 'right-dock' | 'overlay'
  readonly minWidth?: number
  readonly maxWidth?: number
  readonly defaultWidth?: number
  readonly settings?: ContextPanelSettingsContribution
  readonly when?: (context: ContextPanelContributionContext) => boolean
  /** Optional Settings schema. A missing adapter keeps the panel opaque. */
  readonly schema?: SettingsSchema
  readonly valueAdapter?: SettingsValueAdapter
}

export interface FirstPartyContextPanelContribution extends ContextPanelContributionBase {
  /**
   * #515 契约翻转：第一方贡献组件是 **Solid 组件**（宿主右栏 Solid 实体直连渲染，
   * React 岛已退役）。#520 终局收尾批把字面量定名为 `first-party-solid`（旧值为
   * React 时代遗留命名）——判别器的消费面语义不变：「非 isolated-surface 即第一方
   * 同运行时组件」，组件值为 Solid `Component`，框架语义由 component 值本身承载。
   */
  readonly renderKind: 'first-party-solid'
  readonly component: Component<ContextPanelContributionProps>
}

export interface IsolatedContextPanelContribution extends ContextPanelContributionBase {
  readonly renderKind: 'isolated-surface'
  readonly surfaceId: string
}

export type ContextPanelContribution = FirstPartyContextPanelContribution | IsolatedContextPanelContribution
export type ContextPanelRegistryEntry = RegistryEntry<ContextPanelContribution>
