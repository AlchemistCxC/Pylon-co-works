import type { PluginIdentity } from './pluginIdentity.ts'
import type {
  PluginActivationTransactions,
} from './pluginActivationContext.ts'
import type { PluginHostServices } from './pluginHostServices.ts'
import { runRegistryBatch } from './registry/registryBatch.ts'

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

  constructor(
    host: PluginHostServices,
    candidate: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ) {
    const { registries } = host
    this.transactions = {
      application: host.application.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      commands: registries.commandRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      hooks: host.hooks.registry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      renderer: registries.rendererRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      workspace: registries.workspaceRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      ui: registries.pluginUiRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      services: registries.pluginServiceRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      sidebar: registries.agentSidebarRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      fileWorkbench: registries.fileWorkbenchRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      contextPanel: registries.contextPanelRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      presentation: registries.presentationProfileRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      settings: registries.pluginSettingsPageRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      settingOptions: registries.pluginSettingOptionsRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      fonts: registries.fontContributionRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      sessionCreation: registries.sessionCreationRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
      interfaceModes: registries.interfaceModeRegistry.beginShadowTransaction(candidate, replacingRuntimeInstanceId),
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
