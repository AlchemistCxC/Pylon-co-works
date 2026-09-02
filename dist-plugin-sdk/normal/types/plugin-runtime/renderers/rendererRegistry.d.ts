import { type PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistryEntry } from '../registry/types.js';
import type { CodeHighlighterDefinition, CodeHighlighterInput, ContentRendererDefinition, ContentRendererInput, MessageRendererDefinition, MessageRendererInput, ToolRendererDefinition, ToolRendererInput, RenderKindDefinition, RenderNode, RenderResolveContext } from './rendererTypes.js';
import type { RendererSlotContribution, RendererSuiteContribution } from './rendererSuiteTypes.js';
export type { RendererActivationSnapshot, RendererDiagnostic, RendererSlotContribution, RendererSuiteContribution } from './rendererSuiteTypes.js';
export type { CodeHighlighterDefinition, ContentRendererDefinition, MessageRendererDefinition, RendererDefinitionBase, RenderKindDefinition, RenderNode, RenderResolveContext, ToolRendererDefinition, } from './rendererTypes.js';
export type { RendererApi } from './pluginRendererApi.js';
export interface RendererRegistryTransaction {
    registerRenderKind(definition: RenderKindDefinition): AsyncDisposable;
    registerSuite(definition: RendererSuiteContribution): AsyncDisposable;
    registerSlot(definition: RendererSlotContribution): AsyncDisposable;
    registerSolidRenderer(definition: MessageRendererDefinition): AsyncDisposable;
    registerMessageRenderer(definition: MessageRendererDefinition): AsyncDisposable;
    registerContentRenderer(definition: ContentRendererDefinition): AsyncDisposable;
    registerToolRenderer(definition: ToolRendererDefinition): AsyncDisposable;
    registerCodeHighlighter(definition: CodeHighlighterDefinition): AsyncDisposable;
    /** Immutable candidate view; never published and never persisted. */
    preview(): RendererRegistrySnapshot;
    validate(): void;
    commit(): void;
    rollback(): void;
    revert(): void;
}
export interface RendererRegistrySnapshot {
    readonly revision: number;
    readonly renderKinds: readonly RegistryEntry<RenderKindDefinition>[];
    /** @deprecated compatibility adapters; new consumers resolve Suite/Slot. */
    readonly messageRenderers: readonly RegistryEntry<MessageRendererDefinition>[];
    /** @deprecated compatibility adapters; new consumers resolve Suite/Slot. */
    readonly contentRenderers: readonly RegistryEntry<ContentRendererDefinition>[];
    /** @deprecated compatibility adapters; new consumers resolve Suite/Slot. */
    readonly toolRenderers: readonly RegistryEntry<ToolRendererDefinition>[];
    /** @deprecated compatibility adapters; new consumers resolve Suite/Slot. */
    readonly codeHighlighters: readonly RegistryEntry<CodeHighlighterDefinition>[];
    /** Atomic Suite contributions. */
    readonly rendererSuites: readonly RegistryEntry<RendererSuiteContribution>[];
    /** Suite-local Slot contributions. */
    readonly rendererSlots: readonly RegistryEntry<RendererSlotContribution>[];
}
export interface ResolvedRenderer {
    readonly kind: string;
    readonly rendererId?: string;
    readonly renderer?: RegistryEntry<MessageRendererDefinition | ContentRendererDefinition | ToolRendererDefinition | CodeHighlighterDefinition>;
    readonly fallback: boolean;
    readonly diagnostics: readonly {
        code: string;
        message: string;
        kind?: string;
        rendererId?: string;
    }[];
}
export interface RenderCatalogSnapshot extends RendererRegistrySnapshot {
}
export declare class RendererRegistry {
    private readonly kinds;
    private readonly messages;
    private readonly contents;
    private readonly tools;
    private readonly highlighters;
    private readonly suites;
    private readonly slots;
    private readonly listeners;
    private revision;
    private batchDepth;
    private publishQueued;
    private snapshotValue;
    constructor();
    registerRenderKind(owner: PluginIdentity, definition: RenderKindDefinition): AsyncDisposable;
    registerSuite(owner: PluginIdentity, definition: RendererSuiteContribution): AsyncDisposable;
    registerSlot(owner: PluginIdentity, definition: RendererSlotContribution): AsyncDisposable;
    registerSolidRenderer(owner: PluginIdentity, definition: MessageRendererDefinition): AsyncDisposable;
    registerMessageRenderer(owner: PluginIdentity, definition: MessageRendererDefinition): AsyncDisposable;
    registerContentRenderer(owner: PluginIdentity, definition: ContentRendererDefinition): AsyncDisposable;
    registerToolRenderer(owner: PluginIdentity, definition: ToolRendererDefinition): AsyncDisposable;
    registerCodeHighlighter(owner: PluginIdentity, definition: CodeHighlighterDefinition): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RendererRegistryTransaction;
    resolveMessageRenderer(input?: MessageRendererInput): RegistryEntry<MessageRendererDefinition>;
    resolveFallbackMessageRenderer(input?: MessageRendererInput, excludedContributionId?: string): RegistryEntry<MessageRendererDefinition>;
    resolveContentRenderer(input: ContentRendererInput): RegistryEntry<ContentRendererDefinition>;
    resolveToolRenderer(input: ToolRendererInput): RegistryEntry<ToolRendererDefinition>;
    resolveCodeHighlighter(input: CodeHighlighterInput): RegistryEntry<CodeHighlighterDefinition>;
    resolveSurface(node: RenderNode, context?: RenderResolveContext): ResolvedRenderer;
    snapshot(): RenderCatalogSnapshot;
    subscribe(listener: () => void): () => void;
    private publish;
}
