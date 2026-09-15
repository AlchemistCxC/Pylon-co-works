import type { RegistrySnapshot } from '../../plugin-runtime/registry/types.ts'
import type { CcWidgetContribution, ResolvedCcWidget } from '../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

/** 目录条目：注册表快照条目与裸数组元素共用的最小字段面 */
type CcWidgetCatalogEntry = {
  readonly value: CcWidgetContribution
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly contributionId: string
}

/**
 * Array.isArray 不能把 `readonly T[]` 从联合里收窄掉（TS 已知限制），
 * 而且数组自带 `.entries()` 方法 → 直接取属性会得到 `() => ArrayIterator`。
 * 用显式类型谓词守卫，两条分支都归一到 `readonly CcWidgetCatalogEntry[]`。
 */
const isCatalogEntryArray = (value: unknown): value is readonly CcWidgetCatalogEntry[] => Array.isArray(value)

export function mergeCcWidgetCatalog(
  builtin: readonly CcWidgetContribution[],
  pluginSnapshot: RegistrySnapshot<CcWidgetContribution> | readonly CcWidgetCatalogEntry[],
): ResolvedCcWidget[] {
  const entries: readonly CcWidgetCatalogEntry[] = isCatalogEntryArray(pluginSnapshot)
    ? pluginSnapshot
    : pluginSnapshot.entries
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
