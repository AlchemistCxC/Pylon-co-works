import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { AgentSidebarContribution, AgentSidebarMode } from './sidebarTypes.ts'

function validateContribution(contribution: AgentSidebarContribution): AgentSidebarContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) {
    throw new Error('Agent sidebar contribution id 必须是非空且无首尾空格的字符串')
  }
  if (!contribution.label.trim()) throw new Error(`Agent sidebar contribution label 不能为空：${contribution.id}`)
  if (!['work', 'chat'].includes(contribution.mode)) {
    throw new Error(`Agent sidebar contribution mode 非法：${contribution.id}`)
  }
  if (contribution.renderKind === 'first-party-react' && typeof contribution.component !== 'function' && typeof contribution.component !== 'object') {
    throw new Error(`Agent sidebar first-party component 非法：${contribution.id}`)
  }
  if (contribution.renderKind === 'isolated-surface' && !contribution.surfaceId.trim()) {
    throw new Error(`Agent sidebar isolated surfaceId 不能为空：${contribution.id}`)
  }
  return Object.freeze({ ...contribution })
}

export class AgentSidebarRegistry {
  private readonly registry = new ReactiveRegistryStore<AgentSidebarContribution>()

  register(identity: PluginIdentity, contribution: AgentSidebarContribution): AsyncDisposable {
    const normalized = validateContribution(contribution)
    return this.registry.register(identity, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<AgentSidebarContribution> {
    return this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  getSnapshot(): RegistrySnapshot<AgentSidebarContribution> {
    return this.registry.getSnapshot()
  }

  list(mode?: AgentSidebarMode): readonly AgentSidebarContribution[] {
    return this.registry.getSnapshot().entries
      .filter(entry => mode === undefined || entry.value.mode === mode)
      .map(entry => entry.value)
  }
}
