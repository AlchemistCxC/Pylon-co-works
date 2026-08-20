import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { PluginSettingsPageRegistry } from './pluginSettingsRegistry.ts'
import type { PluginSettingsStore } from './pluginSettingsStore.ts'
import type { PluginSettingsPageContribution, PluginSettingValue } from './pluginSettingsTypes.ts'
import type { PluginSettingOptionsContribution } from './pluginSettingsTypes.ts'
import type { PluginSettingOptionsRegistry } from './pluginSettingOptionsRegistry.ts'

export interface PluginSettingsApi {
  registerPage(page: PluginSettingsPageContribution): void
  registerOptions(contribution: PluginSettingOptionsContribution): void
  getValue(key: string): PluginSettingValue | undefined
  setValue(key: string, value: PluginSettingValue): void
  removeValue(key: string): void
  subscribe(listener: () => void): () => void
}

export function createPluginSettingsApi(
  registry: PluginSettingsPageRegistry,
  store: PluginSettingsStore,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<PluginSettingsPageContribution>,
  optionsRegistry?: PluginSettingOptionsRegistry,
  optionsTransaction?: RegistryTransaction<PluginSettingOptionsContribution>,
): PluginSettingsApi {
  return {
    registerPage(page) {
      const registration = transaction
        ? transaction.register(page, { contributionId: page.id, priority: page.order })
        : registry.register(identity, page)
      try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
    },
    registerOptions(contribution) {
      if (!optionsRegistry) throw new Error('Plugin setting options registry 未配置')
      const registration = optionsTransaction
        ? optionsTransaction.register(contribution, { contributionId: contribution.id, priority: contribution.order })
        : optionsRegistry.register(identity, contribution)
      try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
    },
    getValue: key => store.get(identity.pluginId, key),
    setValue: (key, value) => store.set(identity.pluginId, key, value),
    removeValue: key => store.remove(identity.pluginId, key),
    subscribe(listener) {
      const unsubscribe = store.subscribe(identity.pluginId, listener)
      try { scope.add(unsubscribe) } catch (error) { unsubscribe(); throw error }
      return unsubscribe
    },
  }
}
