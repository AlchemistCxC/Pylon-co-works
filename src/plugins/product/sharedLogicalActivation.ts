import type { PluginScope } from '../../plugin-runtime/pluginScope.ts'

/**
 * Keeps non-transactional product-domain adapters alive while at least one
 * runtime generation owns them. Candidate activation and old-generation
 * disposal therefore cannot create a visibility gap during a hot swap.
 */
export function createSharedLogicalActivation(
  activate: () => void,
  deactivate: () => void | Promise<void>,
): (scope: PluginScope, ownerRuntimeInstanceId: string) => void {
  const owners = new Set<string>()
  return (scope, ownerRuntimeInstanceId) => {
    if (owners.has(ownerRuntimeInstanceId)) return
    if (owners.size === 0) activate()
    owners.add(ownerRuntimeInstanceId)
    scope.add(async () => {
      owners.delete(ownerRuntimeInstanceId)
      if (owners.size === 0) await deactivate()
    })
  }
}
