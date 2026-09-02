import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import type { RendererRegistry, RendererRegistryTransaction } from './rendererRegistry.js';
import type { CodeHighlighterDefinition, ContentRendererDefinition, MessageRendererDefinition, ToolRendererDefinition, RenderKindDefinition } from './rendererTypes.js';
import type { RendererSlotContribution, RendererSuiteContribution } from './rendererSuiteTypes.js';
export interface RendererApi {
    registerRenderKind(renderer: RenderKindDefinition): ReturnType<RendererRegistry['registerRenderKind']>;
    /** C00：批量注册（shadow transaction 原子提交），供内置 kind 组一次落 catalog。 */
    registerRenderKinds(renderers: readonly RenderKindDefinition[]): void;
    registerSuite(renderer: RendererSuiteContribution): ReturnType<RendererRegistry['registerSuite']>;
    registerSlot(renderer: RendererSlotContribution): ReturnType<RendererRegistry['registerSlot']>;
    registerSolidRenderer(renderer: MessageRendererDefinition): ReturnType<RendererRegistry['registerSolidRenderer']>;
    registerMessageRenderer(renderer: MessageRendererDefinition): ReturnType<RendererRegistry['registerMessageRenderer']>;
    registerContentRenderer(renderer: ContentRendererDefinition): ReturnType<RendererRegistry['registerContentRenderer']>;
    registerToolRenderer(renderer: ToolRendererDefinition): ReturnType<RendererRegistry['registerToolRenderer']>;
    registerCodeHighlighter(renderer: CodeHighlighterDefinition): ReturnType<RendererRegistry['registerCodeHighlighter']>;
}
export declare function createPluginRendererApi(registry: RendererRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RendererRegistryTransaction): RendererApi;
