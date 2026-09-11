import type { BuiltinPluginActivationContext } from '../../../plugin-runtime/pluginActivationContext.ts'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'
import { BUILTIN_CC_SEND_BUTTON_CONTRIBUTION, BUILTIN_CC_SURFACE_CONTRIBUTION } from '../../../domains/cc/widgetCatalog.ts'

export function createBuiltinCcWidgetPluginDefinition(): BuiltinPluginDefinition {
  return {
    id: 'builtin.pylon-cc-widgets',
    kind: 'feature',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: registerBuiltinCcWidgets,
  }
}

export function registerBuiltinCcWidgets(context: BuiltinPluginActivationContext): void {
  context.ccWidget.registerWidget(BUILTIN_CC_SURFACE_CONTRIBUTION)
  context.ccWidget.registerWidget(BUILTIN_CC_SEND_BUTTON_CONTRIBUTION)
}
