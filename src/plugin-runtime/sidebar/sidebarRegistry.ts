import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import { AGENT_SIDEBAR_REGIONS, type AgentSidebarContribution, type AgentSidebarHeaderAction, type AgentSidebarRegion } from './sidebarTypes.ts'

function validateHeaderActions(contribution: AgentSidebarContribution): void {
  const actions = contribution.headerActions
  if (actions === undefined) return
  if (!Array.isArray(actions)) throw new Error(`Agent sidebar headerActions 必须是数组：${contribution.id}`)
  const seen = new Set<string>()
  for (const action of actions as readonly AgentSidebarHeaderAction[]) {
    if (!action || typeof action !== 'object') throw new Error(`Agent sidebar headerActions 项非法：${contribution.id}`)
    if (!action.id || action.id !== action.id.trim()) {
      throw new Error(`Agent sidebar headerActions[].id 必须是非空且无首尾空格的字符串：${contribution.id}`)
    }
    if (seen.has(action.id)) throw new Error(`Agent sidebar headerActions id 重复：${contribution.id}/${action.id}`)
    seen.add(action.id)
    if (typeof action.label !== 'string' || !action.label.trim()) {
      throw new Error(`Agent sidebar headerActions[].label 不能为空：${contribution.id}/${action.id}`)
    }
  }
}

function validateContribution(contribution: AgentSidebarContribution): AgentSidebarContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) {
    throw new Error('Agent sidebar contribution id 必须是非空且无首尾空格的字符串')
  }
  if (!contribution.label.trim()) throw new Error(`Agent sidebar contribution label 不能为空：${contribution.id}`)
  if (!AGENT_SIDEBAR_REGIONS.includes(contribution.region)) {
    throw new Error(`Agent sidebar contribution region 非法：${contribution.id}`)
  }
  if (contribution.page !== undefined) {
    if (!contribution.page || typeof contribution.page !== 'object') {
      throw new Error(`Agent sidebar contribution page 非法：${contribution.id}`)
    }
    if (typeof contribution.page.title !== 'string' || !contribution.page.title.trim()) {
      throw new Error(`Agent sidebar contribution page.title 不能为空：${contribution.id}`)
    }
  }
  validateHeaderActions(contribution)
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

  list(region?: AgentSidebarRegion): readonly AgentSidebarContribution[] {
    return this.registry.getSnapshot().entries
      .filter(entry => region === undefined || entry.value.region === region)
      .map(entry => entry.value)
  }
}
