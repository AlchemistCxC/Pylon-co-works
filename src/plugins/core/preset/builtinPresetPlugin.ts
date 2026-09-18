import type { BuiltinPluginActivationContext } from '../../../plugin-runtime/pluginActivationContext.ts'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'

export function createBuiltinPresetPluginDefinition(): BuiltinPluginDefinition {
  return {
    id: 'builtin.pylon-presets',
    kind: 'feature',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: registerBuiltinPresets,
  }
}

export function registerBuiltinPresets(_context: BuiltinPluginActivationContext): void {
  // 刀1 只交付能力槽：本刀不注册任何预设，出厂预设的数据接入留刀3。
}
