import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RendererRegistry, RendererRegistryTransaction } from './rendererRegistry.ts'
import type {
  CodeHighlighterDefinition,
  ContentRendererDefinition,
  MessageRendererDefinition,
  ToolRendererDefinition,
  RenderKindDefinition,
} from './rendererTypes.ts'
import type { RendererSlotContribution, RendererSuiteContribution } from './rendererSuiteTypes.ts'

export interface RendererApi {
  registerRenderKind(renderer: RenderKindDefinition): ReturnType<RendererRegistry['registerRenderKind']>
  /** C00：批量注册（shadow transaction 原子提交），供内置 kind 组一次落 catalog。 */
  registerRenderKinds(renderers: readonly RenderKindDefinition[]): void
  registerSuite(renderer: RendererSuiteContribution): ReturnType<RendererRegistry['registerSuite']>
  registerSlot(renderer: RendererSlotContribution): ReturnType<RendererRegistry['registerSlot']>
  registerSolidRenderer(renderer: MessageRendererDefinition): ReturnType<RendererRegistry['registerSolidRenderer']>
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
    registerRenderKind: definition => register(() => transaction
      ? transaction.registerRenderKind(definition)
      : registry.registerRenderKind(identity, definition)),
    registerRenderKinds: definitions => {
      if (definitions.length === 0) return
      if (transaction) {
        for (const definition of definitions) transaction.registerRenderKind(definition)
        return
      }
      // 独立调用（无外层 transaction）：一次 shadow transaction 原子提交整组 kind，
      // 避免 message.user/assistant 这类互引 fallback 链出现注册中间态。
      const shadow = registry.beginShadowTransaction(identity, identity.key)
      try {
        for (const definition of definitions) shadow.registerRenderKind(definition)
        shadow.validate()
        shadow.commit()
      } catch (error) {
        shadow.rollback()
        throw error
      }
    },
    registerSuite: definition => register(() => transaction
      ? transaction.registerSuite(definition)
      : registry.registerSuite(identity, definition)),
    registerSlot: definition => register(() => transaction
      ? transaction.registerSlot(definition)
      : registry.registerSlot(identity, definition)),
    registerSolidRenderer: definition => register(() => transaction
      ? transaction.registerSolidRenderer(definition)
      : registry.registerSolidRenderer(identity, definition)),
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
