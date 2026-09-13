/**
 * Agent-scoped advertised model set for the empty-state control center.
 *
 * ACP advertises model choices per session (session/new response,
 * config_option_update). The runtime store keeps those facts in
 * sessionConfig buckets keyed by [agentId, source] (P56/D3.3), so the union of
 * the buckets belonging to one agent is the closest available "该 agent 可用的
 * 模型集合" before a session exists. modelChoices (id/label) is the label
 * truth source; plain `models` ids are the fallback projection.
 *
 * Lives outside src/renderers/**: the renderer subtree must not import the
 * runtime store (check-runtime-boundaries), so the suite host subscribes and
 * hands the renderer plain frozen entries via WorkbenchMountInput.
 */
import { useRuntimeStore, type SessionConfig } from '../../runtimeStore.ts'
import type { WorkbenchOptionEntry } from '../../renderers/solid-workbench/input/workbenchOptionCatalog.ts'

function bucketAgentId(key: string): string | undefined {
  try {
    const parsed = JSON.parse(key)
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined
  } catch {
    return undefined
  }
}

function entriesFromConfig(config: SessionConfig | undefined): readonly WorkbenchOptionEntry[] {
  if (!config) return []
  const choices = config.modelChoices?.length ? config.modelChoices : undefined
  const ids = choices ? choices.map(choice => choice.id) : config.models
  const result: WorkbenchOptionEntry[] = []
  const seen = new Set<string>()
  for (const id of ids ?? []) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue
    seen.add(trimmed.toLowerCase())
    const label = choices?.find(choice => choice.id === trimmed)?.label
    result.push(Object.freeze({ id: trimmed, label: label?.trim() || trimmed }))
  }
  return result
}

function computeEntries(config: Record<string, SessionConfig>, agentId: string): readonly WorkbenchOptionEntry[] {
  const result: WorkbenchOptionEntry[] = []
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(config)) {
    if (bucketAgentId(key) !== agentId) continue
    for (const entry of entriesFromConfig(value)) {
      if (seen.has(entry.id.toLowerCase())) continue
      seen.add(entry.id.toLowerCase())
      result.push(entry)
    }
  }
  return Object.freeze(result)
}

interface AgentModelsCache {
  sessionConfig: Record<string, SessionConfig>
  agentId: string
  entries: readonly WorkbenchOptionEntry[]
}

let cache: AgentModelsCache | undefined

/**
 * Returns the agent's advertised entries with a cached identity so a React
 * `useSyncExternalStore(getSnapshot)` can compare by reference: the same
 * sessionConfig object and agent id always yield the same frozen array.
 */
export function agentAdvertisedModelEntries(agentId: string): readonly WorkbenchOptionEntry[] {
  const sessionConfig = useRuntimeStore.getState().sessionConfig
  if (cache && cache.sessionConfig === sessionConfig && cache.agentId === agentId) return cache.entries
  cache = { sessionConfig, agentId, entries: computeEntries(sessionConfig, agentId) }
  return cache.entries
}
