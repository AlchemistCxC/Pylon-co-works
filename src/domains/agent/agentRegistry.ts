import type { AgentEntry } from './agentEntry.ts'
import type {
  AgentDescriptor,
  AgentInstanceDescriptor,
  AgentInstanceId,
  AgentProviderId,
  InteractionAdapterContract,
} from './agentContracts.ts'
import { resolveActivity } from '../activity/activity.ts'
import { normalizeInteractionRequest } from '../activity/interaction.ts'
import { resolveToolType, type ToolResolution, type ToolProvider } from '../tool/toolPresentation.ts'
import { applyToolRegistryOverlay, clearToolRegistryForTests, removeToolRegistryOverlay } from '../tool/toolRegistry.ts'

const descriptors = new Map<AgentProviderId, AgentDescriptor>()
const instances = new Map<AgentInstanceId, AgentInstanceDescriptor>()
const adapters = new Map<string, InteractionAdapterContract>()
const instanceToolScopes = new Set<string>()

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase()
}

export function registerAgentDescriptor(
  descriptor: AgentDescriptor,
  options: { registerTools?: boolean } = {},
): void {
  const provider = normalizeProvider(descriptor.provider)
  if (!provider) throw new Error('Agent provider 不能为空')
  const normalized = { ...descriptor, provider }
  descriptors.set(provider, normalized)
  if (options.registerTools !== false) {
    applyToolRegistryOverlay('agent-descriptor', provider, {
      upsert: normalized.tools.map(tool => ({
        provider,
        name: tool.name,
        aliases: tool.aliases,
        kind: tool.kind,
        action: tool.action,
      })),
    })
  } else {
    removeToolRegistryOverlay('agent-descriptor', provider)
  }
  for (const [agentId, instance] of instances) {
    if (instance.provider !== provider) continue
    instances.set(agentId, { ...instance, descriptor: normalized, state: 'ready', issue: undefined })
  }
}

export function getAgentDescriptor(provider: AgentProviderId): AgentDescriptor | null {
  return descriptors.get(normalizeProvider(provider)) ?? null
}

export function listAgentDescriptors(): AgentDescriptor[] {
  return [...descriptors.values()]
}

/** 按 provider 卸载 agent 描述符/实例/交互适配器（不触碰 tool registry——tool 字典由 tool.provider 独立管理）。 */
export function unregisterAgentDescriptorProvider(provider: AgentProviderId): void {
  const normalized = normalizeProvider(provider)
  descriptors.delete(normalized)
  removeToolRegistryOverlay('agent-descriptor', normalized)
  for (const [agentId, instance] of instances) {
    if (instance.provider === normalized) instances.delete(agentId)
  }
  for (const [id, adapter] of adapters) {
    if (adapter.provider === normalized) adapters.delete(id)
  }
}

export function replaceAgentInstances(entries: readonly AgentEntry[]): AgentInstanceDescriptor[] {
  for (const scope of instanceToolScopes) removeToolRegistryOverlay('agent-instance', scope)
  instanceToolScopes.clear()
  const next = new Map<AgentInstanceId, AgentInstanceDescriptor>()
  for (const entry of entries) {
    const agentId = entry.id.trim()
    const provider = normalizeProvider(entry.provider ?? '')
    if (!agentId || !provider) {
      if (agentId) next.set(agentId, {
        agentId,
        provider,
        displayName: entry.name || agentId,
        descriptor: null,
        state: 'degraded',
        issue: 'invalid-instance',
      })
      continue
    }
    const toolOverlay = entry.toolOverlay ?? entry.tools
    if (toolOverlay !== undefined) {
      const overlay = Array.isArray(toolOverlay)
        ? { upsert: toolOverlay.map(item => ({ ...(item as Record<string, unknown>), provider: (item as Record<string, unknown>).provider ?? provider })) }
        : toolOverlay
      applyToolRegistryOverlay('agent-instance', agentId, overlay)
      instanceToolScopes.add(agentId)
    }
    const descriptor = getAgentDescriptor(provider)
    next.set(agentId, {
      agentId,
      provider,
      displayName: entry.name || agentId,
      descriptor,
      state: descriptor ? 'ready' : 'degraded',
      issue: descriptor ? undefined : 'provider-unregistered',
    })
  }
  instances.clear()
  for (const [agentId, instance] of next) instances.set(agentId, instance)
  return listAgentInstances()
}

export function getAgentInstance(agentId: AgentInstanceId): AgentInstanceDescriptor | null {
  return instances.get(agentId) ?? null
}

export function listAgentInstances(): AgentInstanceDescriptor[] {
  return [...instances.values()]
}

export function registerInteractionAdapter(adapter: InteractionAdapterContract): void {
  if (!adapter.id.trim()) throw new Error('Interaction adapter id 不能为空')
  adapters.set(adapter.id, adapter)
}

export function listInteractionAdapters(): InteractionAdapterContract[] {
  return [...adapters.values()]
}

export function resolveAgentTool(input: {
  agentId?: AgentInstanceId
  provider?: AgentProviderId
  name: string
  wireKind?: string
}): ToolResolution {
  const instance = input.agentId ? getAgentInstance(input.agentId) : null
  const provider = instance?.provider ?? (input.provider ? normalizeProvider(input.provider) : undefined)
  const descriptor = instance?.descriptor ?? (provider ? getAgentDescriptor(provider) : null)
  const definition = descriptor?.tools.find(tool =>
    tool.name.toLowerCase() === input.name.trim().toLowerCase()
    || tool.aliases?.some(alias => alias.toLowerCase() === input.name.trim().toLowerCase())
  )
  if (definition) {
    return {
      kind: definition.kind,
      action: definition.action,
      canonicalName: definition.name,
      rawName: input.name,
      provider: (provider ?? 'unknown') as ToolProvider,
      matchedBy: 'provider-dictionary',
    }
  }
  return resolveToolType(input.name, input.wireKind)
}

export function resolveAgentInteraction(input: {
  agentId?: AgentInstanceId
  provider?: AgentProviderId
  eventType?: string
  name?: string
  payload?: unknown
}) {
  const provider = input.agentId
    ? getAgentInstance(input.agentId)?.provider
    : input.provider
  const adapter = listInteractionAdapters().find(candidate => candidate.provider === (provider ?? 'unknown') && candidate.canHandle(input))
  if (adapter) return adapter.normalize(input)
  return normalizeInteractionRequest({ payload: input.payload, eventType: input.eventType, name: input.name })
}

export function resolveAgentInteractionEnvelope(envelope: import('../activity/interaction.ts').InteractionEventEnvelope) {
  const input = { envelope, eventType: envelope.eventType, payload: envelope.payload }
  const adapter = listInteractionAdapters().find(candidate => candidate.provider === envelope.provider && candidate.canHandle(input))
  if (adapter) return adapter.normalize(input)
  return normalizeInteractionRequest({ payload: envelope.payload, eventType: envelope.eventType, metadata: envelope })
}

export function resolveAgentActivity(input: {
  provider?: AgentProviderId
  eventType?: string
  name?: string
  payload?: unknown
}) {
  return resolveActivity({ name: input.name, eventType: input.eventType })
}

export function clearAgentRegistriesForTests(): void {
  descriptors.clear()
  instances.clear()
  adapters.clear()
  for (const scope of instanceToolScopes) removeToolRegistryOverlay('agent-instance', scope)
  instanceToolScopes.clear()
  clearToolRegistryForTests()
}
