import type { RegistrySnapshot } from '../../plugin-runtime/registry/types.ts'
import type { CcWidgetContribution, ResolvedCcWidget } from '../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

export function mergeCcWidgetCatalog(
  builtin: readonly CcWidgetContribution[],
  pluginSnapshot: RegistrySnapshot<CcWidgetContribution> | readonly { value: CcWidgetContribution; ownerPluginId: string; ownerRuntimeInstanceId: string; contributionId: string }[],
): ResolvedCcWidget[] {
  const entries = Array.isArray(pluginSnapshot) ? pluginSnapshot : pluginSnapshot.entries
  const merged = new Map<string, ResolvedCcWidget>()
  for (const contribution of builtin) {
    merged.set(contribution.id, Object.freeze({
      ...contribution,
      ownerPluginId: 'builtin', ownerRuntimeInstanceId: 'builtin', contributionId: contribution.id,
    }))
  }
  for (const entry of entries) {
    if (merged.has(entry.value.id)) continue
    merged.set(entry.value.id, Object.freeze({
      ...entry.value,
      ownerPluginId: entry.ownerPluginId,
      ownerRuntimeInstanceId: entry.ownerRuntimeInstanceId,
      contributionId: entry.contributionId,
    }))
  }
  return [...merged.values()]
}
