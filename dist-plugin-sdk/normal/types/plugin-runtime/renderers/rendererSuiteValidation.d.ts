import type { RegistryEntry } from '../registry/types.js';
import type { RenderKindDefinition } from './rendererTypes.js';
import type { RendererSlotContribution, RendererSuiteContribution } from './rendererSuiteTypes.js';
export declare function validateRenderKindSettingsNamespace(kind: RenderKindDefinition): void;
export declare function validateRendererSuiteContribution(suite: RendererSuiteContribution, suites?: readonly RegistryEntry<RendererSuiteContribution>[], kinds?: readonly RegistryEntry<RenderKindDefinition>[], allowMissingFallback?: boolean, allowMissingKinds?: boolean): RendererSuiteContribution;
export declare function validateRendererSlotContribution(slot: RendererSlotContribution, suites: readonly RegistryEntry<RendererSuiteContribution>[], kinds: readonly RegistryEntry<RenderKindDefinition>[], allowMissingReferences?: boolean): RendererSlotContribution;
export interface RendererContributionGraph {
    readonly suites: readonly RegistryEntry<RendererSuiteContribution>[];
    readonly slots: readonly RegistryEntry<RendererSlotContribution>[];
    readonly kinds: readonly RegistryEntry<RenderKindDefinition>[];
}
export declare function validateRendererContributionGraph(graph: RendererContributionGraph): void;
