import { BUILTIN_TOOL_RENDERERS } from '../../../domains/tool/builtinToolRenderers.ts'
import { TOOL_KINDS } from '../../../domains/tool/toolKinds.ts'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'

export const CORE_TOOL_RENDERER_PLUGIN_ID = 'core.renderer.tool'

export function createBuiltinToolRendererPluginDefinition(): BuiltinPluginDefinition {
  return {
    id: CORE_TOOL_RENDERER_PLUGIN_ID,
    activate: ({ renderer }) => {
      for (const kind of TOOL_KINDS) {
        renderer.registerToolRenderer({
          id: `${CORE_TOOL_RENDERER_PLUGIN_ID}.${kind}`,
          kind,
          renderer: BUILTIN_TOOL_RENDERERS[kind],
          priority: kind === 'other' ? 10_000 : 1000,
          fallback: kind === 'other',
          canRender: input => input.kind === kind,
          onError: () => 'fallback',
        })
      }
    },
  }
}
