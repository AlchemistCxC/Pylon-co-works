import type { Component } from 'solid-js'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { AsyncDisposable } from '../registry/types.ts'

export interface PluginApplicationContribution {
  id: string
  /** #515：application 贡献组件为 Solid `Component`（插件契约随前端终态翻转）。 */
  component: Component
}

export interface PluginApplicationRegistryTransaction {
  register(contribution: PluginApplicationContribution): AsyncDisposable
  validate(): void
  commit(): void
  rollback(): void
  revert(): void
}

export interface PluginApplicationHost {
  register(owner: PluginIdentity, contribution: PluginApplicationContribution): AsyncDisposable
  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): PluginApplicationRegistryTransaction
}
