import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { PluginSettingsPageContribution } from './pluginSettingsTypes.ts'

export function validatePluginSettingsPage(page: PluginSettingsPageContribution): PluginSettingsPageContribution {
  if (!page.id || page.id !== page.id.trim()) throw new Error('Plugin settings page id 非法')
  if (!page.label?.trim()) throw new Error(`Plugin settings page label 不能为空：${page.id}`)
  if (page.renderKind === 'first-party-react' && typeof page.component !== 'function' && typeof page.component !== 'object') {
    throw new Error(`Plugin settings page component 非法：${page.id}`)
  }
  if (page.renderKind === 'isolated-surface' && !page.surfaceId?.trim()) {
    throw new Error(`Plugin settings page surfaceId 不能为空：${page.id}`)
  }
  return Object.freeze({ ...page })
}

export class PluginSettingsPageRegistry {
  private readonly registry = new ReactiveRegistryStore<PluginSettingsPageContribution>()

  register(owner: PluginIdentity, page: PluginSettingsPageContribution): AsyncDisposable {
    const normalized = validatePluginSettingsPage(page)
    return this.registry.register(owner, normalized, { contributionId: normalized.id, priority: normalized.order })
  }

  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<PluginSettingsPageContribution> {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      ...transaction,
      register: (page, options) => {
        const normalized = validatePluginSettingsPage(page)
        return transaction.register(normalized, { ...options, contributionId: normalized.id, priority: normalized.order })
      },
    }
  }

  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<PluginSettingsPageContribution> { return this.registry.getSnapshot() }
}
