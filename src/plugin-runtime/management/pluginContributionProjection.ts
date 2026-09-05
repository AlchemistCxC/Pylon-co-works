/**
 * P53 D2 · 贡献面透视：每插件注册贡献的只读摘要投影（plugin-runtime 层）。
 *
 * 数据源 = RuntimeRegistries 各 registry 的 getSnapshot()（ownerPluginId 已
 * 在 RegistryEntry 上）——不改动 PluginScope/registry 的注册与清理语义，
 * 纯增量只读投影（施工书工程核实点：scope 快照缺 registration 元数据的
 * 替代实现）。
 */
import type { RuntimeRegistries } from '../pluginHostServices.ts'
import type { PluginContributionFact } from './pluginManagementTypes.ts'

export interface PluginContributionSource {
  readonly id: string
  readonly entries: readonly { readonly contributionId: string; readonly ownerPluginId: string }[]
}

function projectContributions(
  sources: readonly PluginContributionSource[],
): readonly PluginContributionFact[] {
  const byPlugin = new Map<string, Map<string, string[]>>()
  for (const source of sources) {
    for (const entry of source.entries) {
      if (!entry.ownerPluginId) continue
      let registries = byPlugin.get(entry.ownerPluginId)
      if (!registries) {
        registries = new Map()
        byPlugin.set(entry.ownerPluginId, registries)
      }
      const ids = registries.get(source.id) ?? []
      ids.push(entry.contributionId)
      registries.set(source.id, ids)
    }
  }
  const facts: PluginContributionFact[] = []
  for (const [pluginId, registries] of byPlugin) {
    const contributions: Record<string, readonly string[]> = {}
    let total = 0
    for (const [surface, ids] of registries) {
      contributions[surface] = Object.freeze([...ids].sort())
      total += ids.length
    }
    facts.push({ pluginId, contributions, total })
  }
  return facts.sort((a, b) => a.pluginId.localeCompare(b.pluginId))
}

const CONTRIBUTION_REGISTRY_KEYS: readonly (readonly [
  registry: keyof RuntimeRegistries,
  surface: string,
])[] = [
  ['commandRegistry', 'commands'],
  ['rendererRegistry', 'renderers'],
  ['pluginUiRegistry', 'ui-surfaces'],
  ['pluginServiceRegistry', 'services'],
  ['agentSidebarRegistry', 'sidebar'],
  ['fileWorkbenchRegistry', 'file-workbench'],
  ['contextPanelRegistry', 'context-panels'],
  ['presentationProfileRegistry', 'presentation-profiles'],
  ['pluginSettingsPageRegistry', 'settings-pages'],
  ['pluginSettingOptionsRegistry', 'setting-options'],
  ['fontContributionRegistry', 'fonts'],
  ['sessionCreationRegistry', 'session-creation'],
  ['interfaceModeRegistry', 'interface-modes'],
  ['titlebarRegistry', 'titlebar'],
  ['workspaceRegistry', 'workspaces'],
]

/** 从 host registries 投影全部插件的贡献摘要（只读，零注册语义改动）。 */
export function readPluginContributionFacts(
  registries: RuntimeRegistries,
): readonly PluginContributionFact[] {
  const sources: PluginContributionSource[] = []
  for (const [registryKey, surface] of CONTRIBUTION_REGISTRY_KEYS) {
    const registry = registries[registryKey] as
      | { getSnapshot?: () => { entries: readonly { contributionId: string; ownerPluginId: string }[] } }
      | undefined
    if (!registry || typeof registry.getSnapshot !== 'function') continue
    try {
      const snapshot = registry.getSnapshot()
      sources.push({ id: surface, entries: snapshot.entries })
    } catch {
      // 个别 registry 无快照能力时跳过，不阻塞整体投影
    }
  }
  return projectContributions(sources)
}
