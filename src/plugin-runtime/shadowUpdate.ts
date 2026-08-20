import { beginWorkspaceShadowTransaction } from '../workspace-sheets/workspaceRegistry.ts'
import type { PluginIdentity } from './pluginIdentity.ts'
import type { PluginActivationTransactions } from './pluginActivationContext.ts'
import { getAgentSidebarRegistry, getCommandRegistry, getContextPanelRegistry, getFileWorkbenchRegistry, getFontContributionRegistry, getHookRuntime, getInterfaceModeRegistry, getPluginServiceRegistry, getPluginSettingOptionsRegistry, getPluginSettingsPageRegistry, getPluginUiRegistry, getPresentationProfileRegistry, getRendererRegistry, getSessionCreationRegistry } from './runtimeServices.ts'
import { runRegistryBatch } from './registry/registryBatch.ts'
import { applicationRuntime } from '../kernel/applicationRuntimeServices.ts'

export type HotSwapMode = 'parallel' | 'exclusive' | 'soft-remount' | 'restart-required'

export interface PluginUpdateResult {
  readonly pluginId: string
  readonly previousRuntimeInstanceId: string
  readonly runtimeInstanceId: string
  readonly declaredMode: HotSwapMode
  readonly adoptedMode: HotSwapMode
}

/**
 * Collects every v2 contribution behind one candidate-only boundary. Individual
 * registries commit synchronously; no async/user code can observe a half-built
 * candidate between validate and the completed commit call.
 */
export class PluginContributionTransaction {
  readonly transactions: PluginActivationTransactions
  private state: 'open' | 'committed' | 'rolled-back' | 'reverted' = 'open'

  constructor(candidate: PluginIdentity, replacingRuntimeInstanceId: string) {
    this.transactions = {
      application: applicationRuntime.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      commands: getCommandRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      hooks: getHookRuntime().registry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      renderer: getRendererRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      workspace: beginWorkspaceShadowTransaction(candidate, replacingRuntimeInstanceId),
      ui: getPluginUiRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      services: getPluginServiceRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      sidebar: getAgentSidebarRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      fileWorkbench: getFileWorkbenchRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      contextPanel: getContextPanelRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      presentation: getPresentationProfileRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      settings: getPluginSettingsPageRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      settingOptions: getPluginSettingOptionsRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      fonts: getFontContributionRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      sessionCreation: getSessionCreationRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      interfaceModes: getInterfaceModeRegistry().beginShadowTransaction(candidate, replacingRuntimeInstanceId),
    }
  }

  validate(): void {
    if (this.state !== 'open') throw new Error(`Shadow transaction 已结算：${this.state}`)
    for (const transaction of Object.values(this.transactions)) transaction.validate()
  }

  commit(): void {
    this.validate()
    this.state = 'committed'
    try {
      runRegistryBatch(() => {
        for (const transaction of Object.values(this.transactions)) transaction.commit()
      })
    } catch (error) {
      for (const transaction of Object.values(this.transactions).reverse()) {
        try { transaction.revert() } catch { /* transaction did not commit */ }
      }
      this.state = 'reverted'
      throw error
    }
  }

  rollback(): void {
    if (this.state !== 'open') throw new Error(`Shadow transaction 无法 rollback：${this.state}`)
    for (const transaction of Object.values(this.transactions)) transaction.rollback()
    this.state = 'rolled-back'
  }

  revert(): void {
    if (this.state !== 'committed') throw new Error(`Shadow transaction 无法 revert：${this.state}`)
    runRegistryBatch(() => {
      for (const transaction of Object.values(this.transactions).reverse()) transaction.revert()
    })
    this.state = 'reverted'
  }
}
