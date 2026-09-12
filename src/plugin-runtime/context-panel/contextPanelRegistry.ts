import { ValidatedContributionRegistry } from '../registry/validatedContributionRegistry.ts'
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

export class ContextPanelRegistry extends ValidatedContributionRegistry<ContextPanelContribution> {
  constructor() {
    super((contribution, owner) => {
      const normalized = validateContribution(contribution)
      validateAdapterIdentity(owner.pluginId, normalized.id, normalized.valueAdapter)
      return normalized
    })
  }

  hasForWorkspace(workspaceKind: string): boolean {
    return this.getSnapshot().entries.some(entry => entry.value.scope === 'global' || entry.value.workspaceKind === workspaceKind)
  }
}
