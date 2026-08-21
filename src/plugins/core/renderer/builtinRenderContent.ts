/** 内置内容渲染器：全部直接注册到 v2 Renderer Registry。 */
import Anser from 'anser'
import { resolveSpinnerFramesBuiltin } from '../../../components/chat/spinnerFrames.ts'
import type {
  AnsiProvider,
  ContentPartProvider,
  FooterProvider,
  PlanProvider,
  SpinnerProvider,
} from '../../../contracts/rendererContentPoints.ts'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'

export const CORE_RENDERER_CONTENT_PART_PLUGIN_ID = 'core.renderer.content-part'

const definitions: Array<{
  id: string
  kind: 'ansi' | 'spinner' | 'content-part' | 'plan' | 'footer'
  provider: AnsiProvider | SpinnerProvider | ContentPartProvider | PlanProvider | FooterProvider
}> = [
  {
    id: 'core.renderer.ansi',
    kind: 'ansi',
    provider: {
      providerId: 'core.renderer.ansi',
      render: text => new Anser().ansiToHtml(Anser.escapeForHtml(text)),
    } satisfies AnsiProvider,
  },
  {
    id: 'core.renderer.spinner',
    kind: 'spinner',
    provider: {
      providerId: 'core.renderer.spinner',
      resolve: (preset, custom) => resolveSpinnerFramesBuiltin(preset as never, custom),
    } satisfies SpinnerProvider,
  },
  {
    id: CORE_RENDERER_CONTENT_PART_PLUGIN_ID,
    kind: 'content-part',
    provider: {
      providerId: CORE_RENDERER_CONTENT_PART_PLUGIN_ID,
      partId: 'assistant',
      label: 'Assistant Markdown',
    } satisfies ContentPartProvider,
  },
  {
    id: 'core.renderer.plan',
    kind: 'plan',
    provider: {
      providerId: 'core.renderer.plan',
      planKind: 'task-tree',
      label: 'TaskTree',
    } satisfies PlanProvider,
  },
  {
    id: 'core.renderer.footer',
    kind: 'footer',
    provider: {
      providerId: 'core.renderer.footer',
      footerKind: 'generation-footer',
      label: 'GenerationFooter',
    } satisfies FooterProvider,
  },
]

export function createBuiltinRendererContentPluginDefinitions(): BuiltinPluginDefinition[] {
  const content = definitions.map(definition => ({
    id: definition.id,
    activate: ({ renderer }) => {
      renderer.registerRenderKind({
        id: `content.${definition.kind}`,
        aliases: [definition.kind],
        category: 'content',
        fallbackKind: 'content.unknown',
        priority: 1000,
        fixture: {},
        defaultTokens: {},
        settingsSchemaVersion: 1,
        validateInput: () => true,
      })
      renderer.registerContentRenderer({
        id: `${definition.id}.provider`,
        kind: definition.kind,
        provider: definition.provider,
        priority: 1000,
        fallback: true,
        canRender: input => input.kind === definition.kind,
        onError: () => 'fallback',
      })
    },
  } satisfies BuiltinPluginDefinition))

  return [
    {
      id: 'core.renderer.code-highlight',
      activate: ({ renderer }) => {
        renderer.registerCodeHighlighter({
          id: 'core.renderer.code-highlight',
          priority: 1000,
          fallback: true,
          canRender: ({ language }) => language.trim().length > 0,
          onError: () => 'fallback',
          highlight: async (language, code) => {
            const { highlightCodeBuiltin } = await import('../../../components/chat/codeHighlight.ts')
            return highlightCodeBuiltin(language, code)
          },
        })
      },
    },
    ...content,
  ]
}
