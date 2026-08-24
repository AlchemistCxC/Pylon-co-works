import type {
  ContextPanelContributionContext,
  ContextPanelRegistryEntry,
} from './contextPanelTypes.ts'
import { reportRuntimeError } from '../../runtimeError.ts'

const reportedWhenFailures = new WeakSet<NonNullable<ContextPanelRegistryEntry['value']['when']>>()

/** Canonical availability selector shared by chrome, layout slot, and host. */
export function selectAvailableContextPanels(
  entries: readonly ContextPanelRegistryEntry[],
  context: ContextPanelContributionContext,
): readonly ContextPanelRegistryEntry[] {
  return entries.filter(entry => {
    if (entry.value.workspaceKind !== context.workspaceKind) return false
    try {
      return entry.value.when?.(context) ?? true
    } catch (error) {
      const predicate = entry.value.when
      if (predicate && !reportedWhenFailures.has(predicate)) {
        reportedWhenFailures.add(predicate)
        reportRuntimeError(`右栏贡献 ${entry.contributionId} 判断可用性`, error)
      }
      return false
    }
  })
}
