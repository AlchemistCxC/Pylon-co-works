/**
 * builtinSkinPlugin — 把 Skin Command 集注册进 v2 Command Registry（阶段 5 S5-E）。
 *
 * owner 为统一 Runtime 内置 skin plugin identity；命令只调用 SkinRuntime，不碰 DOM/Store。
 */
import type { BuiltinPluginDefinition } from '../pluginRuntime.ts'
import { getCommandRegistry } from '../runtimeServices.ts'
import { createSkinCommandDefinitions, type SkinCommandPorts } from './skinCommandApi.ts'
import type { SkinRuntime } from './skinRuntime.ts'

export const BUILTIN_SKIN_PLUGIN_ID = 'builtin.skin'

export function createBuiltinSkinPluginDefinition(
  runtime: SkinRuntime,
  ports: SkinCommandPorts = {},
): BuiltinPluginDefinition {
  return {
    id: BUILTIN_SKIN_PLUGIN_ID,
    activate: ({ identity, scope }) => {
      const registry = getCommandRegistry()
      for (const command of createSkinCommandDefinitions(runtime, ports)) {
        scope.add(registry.register(identity, command, {
          contributionId: `${BUILTIN_SKIN_PLUGIN_ID}.${command.id}`,
          layer: 'platform',
          priority: command.priority,
        }))
      }
    },
  }
}
