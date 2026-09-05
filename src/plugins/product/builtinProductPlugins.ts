import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import type { PylonPluginCapability } from '../../plugin-runtime/packageManifest.ts'
import type { FirstPartyProductPackage } from './firstPartyProductPackage.ts'
import shellPackage from './packages/builtin.pylon-shell/entry.ts'
import workspacePackage from './packages/builtin.pylon-workspace/entry.ts'
import renderersPackage from './packages/builtin.pylon-renderers/entry.ts'
import agentAdaptersPackage from './packages/builtin.pylon-agent-adapters/entry.ts'
import toolsPackage from './packages/builtin.pylon-tools/entry.ts'
import pluginManagerPackage from './packages/builtin.pylon-plugin-manager/entry.ts'

const FIRST_PARTY_PRODUCT_PACKAGES: readonly FirstPartyProductPackage[] = Object.freeze([
  shellPackage,
  workspacePackage,
  renderersPackage,
  agentAdaptersPackage,
  toolsPackage,
  pluginManagerPackage,
])

function orderByDependencies(packages: readonly FirstPartyProductPackage[]): FirstPartyProductPackage[] {
  const packagesById = new Map(packages.map(pkg => [pkg.manifest.id, pkg]))
  for (const pkg of packages) {
    for (const dependency of Object.keys(pkg.manifest.dependencies)) {
      if (!packagesById.has(dependency)) {
        throw new Error(`第一方包依赖不存在：${pkg.manifest.id} -> ${dependency}`)
      }
    }
  }

  const ordered: FirstPartyProductPackage[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (pkg: FirstPartyProductPackage) => {
    if (visited.has(pkg.manifest.id)) return
    if (visiting.has(pkg.manifest.id)) throw new Error(`第一方包依赖成环：${pkg.manifest.id}`)
    visiting.add(pkg.manifest.id)
    for (const dependency of Object.keys(pkg.manifest.dependencies)) visit(packagesById.get(dependency)!)
    visiting.delete(pkg.manifest.id)
    visited.add(pkg.manifest.id)
    ordered.push(pkg)
  }
  for (const pkg of packages) visit(pkg)
  return ordered
}

/**
 * Stage 11 physical package boundary. Every package has its own manifest and entry module;
 * the build emits each entry as a content-hashed first-party ESM artifact while activation
 * still uses the same PluginRuntime/PluginScope as an installed package.
 */
export function loadFirstPartyProductPackages(): readonly FirstPartyProductPackage[] {
  const ids = FIRST_PARTY_PRODUCT_PACKAGES.map(pkg => pkg.manifest.id)
  if (new Set(ids).size !== ids.length) throw new Error('第一方包 id 重复')
  return Object.freeze(orderByDependencies(FIRST_PARTY_PRODUCT_PACKAGES))
}

/** Five coarse first-party product packages mandated by stage 11. */
export function createBuiltinProductPluginDefinitions(): readonly BuiltinPluginDefinition[] {
  const packages = loadFirstPartyProductPackages()
  return Object.freeze(packages.map(pkg => ({
    ...pkg.createDefinition(),
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    packageInstanceId: pkg.packageInstanceId,
    kind: pkg.manifest.kind,
    firstParty: true,
    criticality: 'product-required' as const,
    dependencies: Object.freeze({ ...pkg.manifest.dependencies }),
    optionalDependencies: Object.freeze({ ...pkg.manifest.optionalDependencies }),
    conflicts: Object.freeze([...pkg.manifest.conflicts]),
    activationEvents: Object.freeze([...pkg.manifest.activation.events]),
    // manifest 解析已保证词表封闭；窄化到 capability 字面量类型
    capabilities: pkg.manifest.capabilities
      ? Object.freeze([...pkg.manifest.capabilities] as readonly PylonPluginCapability[])
      : undefined,
    hotSwapMode: pkg.manifest.hotSwap.mode,
    drainTimeoutMs: pkg.manifest.hotSwap.drainTimeoutMs,
  })))
}
