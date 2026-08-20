import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RendererRegistry, RendererRegistryTransaction } from './rendererRegistry.ts'
import type {
  CodeHighlighterDefinition,
  ContentRendererDefinition,
  MessageRendererDefinition,
  ToolRendererDefinition,
} from './rendererTypes.ts'

export interface RendererApi {
  registerMessageRenderer(renderer: MessageRendererDefinition): ReturnType<RendererRegistry['registerMessageRenderer']>
  registerContentRenderer(renderer: ContentRendererDefinition): ReturnType<RendererRegistry['registerContentRenderer']>
  registerToolRenderer(renderer: ToolRendererDefinition): ReturnType<RendererRegistry['registerToolRenderer']>
  registerCodeHighlighter(renderer: CodeHighlighterDefinition): ReturnType<RendererRegistry['registerCodeHighlighter']>
}

export function createPluginRendererApi(
  registry: RendererRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RendererRegistryTransaction,
): RendererApi {
  const register = <T extends { dispose(): void | Promise<void> }>(create: () => T): T => {
    if (scope.isDisposed) throw new Error(`PluginScope 已释放：${scope.ownerKey}`)
    const registration = create()
    try {
      return scope.add(registration)
    } catch (error) {
      void registration.dispose()
      throw error
    }
  }
  return {
    registerMessageRenderer: definition => register(() => transaction
      ? transaction.registerMessageRenderer(definition)
      : registry.registerMessageRenderer(identity, definition)),
    registerContentRenderer: definition => register(() => transaction
      ? transaction.registerContentRenderer(definition)
      : registry.registerContentRenderer(identity, definition)),
    registerToolRenderer: definition => register(() => transaction
      ? transaction.registerToolRenderer(definition)
      : registry.registerToolRenderer(identity, definition)),
    registerCodeHighlighter: definition => register(() => transaction
      ? transaction.registerCodeHighlighter(definition)
      : registry.registerCodeHighlighter(identity, definition)),
  }
}
