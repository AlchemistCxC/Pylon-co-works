/** Public authoring surface for API 1.0 package plugins. */
import {
  parsePylonPluginManifest,
  PYLON_PLUGIN_API_VERSION,
  PYLON_PLUGIN_MANIFEST_FILE,
  type PylonPluginManifest,
} from '../plugin-runtime/packageManifest.ts'
import type { PackagePluginModule } from '../plugin-runtime/packagePluginRuntime.ts'

export type { BuiltinPluginActivationContext as PluginActivationContext } from '../plugin-runtime/pluginActivationContext.ts'
export type { PackagePluginModule } from '../plugin-runtime/packagePluginRuntime.ts'
export type { PylonPluginManifest } from '../plugin-runtime/packageManifest.ts'
export type { FontContribution, FontRole } from '../plugin-runtime/fonts/fontContributionTypes.ts'
export { VISUAL_SEMANTIC_TOKENS } from '../domains/theme/visualSemantics.ts'
export { PYLON_PLUGIN_API_VERSION, PYLON_PLUGIN_MANIFEST_FILE }

/** Gives plugin entry modules a checked, inference-friendly lifecycle definition. */
export function definePlugin(module: PackagePluginModule): PackagePluginModule {
  if (!module || typeof module.activate !== 'function') {
    throw new Error('API 1.0 插件入口必须导出 activate')
  }
  for (const name of ['prepare', 'suspend', 'resume', 'deactivate'] as const) {
    if (module[name] !== undefined && typeof module[name] !== 'function') {
      throw new Error(`插件生命周期 ${name} 必须是函数`)
    }
  }
  return Object.freeze({ ...module })
}

/** Parses and validates the package's pylon-plugin.json API 1.0 manifest. */
export function validatePluginManifest(value: unknown): PylonPluginManifest {
  return parsePylonPluginManifest(value)
}
