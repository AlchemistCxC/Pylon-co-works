import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { ContextPanelContribution } from './contextPanelTypes.ts'
import { normalizeRendererSettingsSchema } from '../renderers/rendererSettingsTypes.ts'

function validateContribution(contribution: ContextPanelContribution): ContextPanelContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) throw new Error('Context panel contribution id 非法')
  if (contribution.scope !== 'global' && !contribution.workspaceKind?.trim()) throw new Error(`Context panel workspaceKind 不能为空：${contribution.id}`)
  if (!contribution.label.trim()) throw new Error(`Context panel label 不能为空：${contribution.id}`)
  if (contribution.renderKind === 'first-party-react' && typeof contribution.component !== 'function' && typeof contribution.component !== 'object') {
    throw new Error(`Context panel first-party component 非法：${contribution.id}`)
  }
  if (contribution.renderKind === 'isolated-surface' && !contribution.surfaceId.trim()) {
    throw new Error(`Context panel isolated surfaceId 不能为空：${contribution.id}`)
  }
  return Object.freeze({ ...contribution, ...(contribution.schema ? { schema: normalizeRendererSettingsSchema(contribution.schema) } : {}) })
}

function validateAdapterIdentity(ownerPluginId: string, contributionId: string, adapter: ContextPanelContribution['valueAdapter']): void {
  if (!adapter) return
  if (adapter.namespace !== 'context-panel') throw new Error(`Context panel adapter namespace 不匹配：${contributionId}`)
  if (adapter.ownerPluginId !== undefined && adapter.ownerPluginId !== ownerPluginId) throw new Error(`Context panel adapter ownerPluginId 不匹配：${contributionId}`)
  if (adapter.contributionId !== undefined && adapter.contributionId !== contributionId) throw new Error(`Context panel adapter contributionId 不匹配：${contributionId}`)
}

export class ContextPanelRegistry {
  private readonly registry = new ReactiveRegistryStore<ContextPanelContribution>()

  register(identity: PluginIdentity, contribution: ContextPanelContribution): AsyncDisposable {
    const normalized = validateContribution(contribution)
    validateAdapterIdentity(identity.pluginId, normalized.id, normalized.valueAdapter)
    return this.registry.register(identity, normalized, { contributionId: normalized.id, priority: normalized.order })
  }

  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<ContextPanelContribution> {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      ...transaction,
      register: (contribution, options) => {
        const normalized = validateContribution(contribution)
        validateAdapterIdentity(owner.pluginId, normalized.id, normalized.valueAdapter)
        return transaction.register(normalized, { ...options, contributionId: normalized.id, priority: normalized.order })
      },
    }
  }

  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<ContextPanelContribution> { return this.registry.getSnapshot() }

  hasForWorkspace(workspaceKind: string): boolean {
    return this.registry.getSnapshot().entries.some(entry => entry.value.scope === 'global' || entry.value.workspaceKind === workspaceKind)
  }
}
