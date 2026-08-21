import type { RenderNodeSnapshot, RenderSurface } from '../../contracts/messageRenderer.ts'
import type { RegistryEntry } from '../registry/types.ts'
import type { RendererSettingsSchema } from './rendererSettingsTypes.ts'
import type { RenderKindDefinition } from './rendererTypes.ts'

export type RendererSuiteId = string

/** Framework-neutral input reserved for the Suite Host (A13). */
export interface WorkbenchRendererFactoryInput {
  readonly suiteId: RendererSuiteId
}

/** A factory owns a complete Workbench implementation; it never receives raw stores. */
export type WorkbenchRendererFactory = (input: WorkbenchRendererFactoryInput) => unknown

export interface RendererSuiteContribution {
  readonly id: RendererSuiteId
  readonly label: string
  readonly description?: string
  readonly apiVersion: 1
  readonly runtime: {
    readonly framework: 'solid'
    readonly version: string
  }
  readonly compatibility: {
    readonly documentSchema: string
    readonly renderCatalogSchema: number
  }
  readonly requiredKinds: readonly string[]
  readonly optionalKinds?: readonly string[]
  readonly fallbackSuiteId?: RendererSuiteId
  readonly settings?: RendererSettingsSchema
  readonly factory: WorkbenchRendererFactory
}

export interface RendererSlotContribution {
  readonly id: string
  readonly label?: string
  readonly description?: string
  readonly targetSuites: readonly (RendererSuiteId | '*')[]
  readonly kinds: readonly string[]
  readonly priority: number
  readonly fallback: boolean
  readonly settings?: RendererSettingsSchema
  canRender(input: RenderNodeSnapshot): boolean
  createSurface(input: RenderNodeSnapshot): RenderSurface
}

export interface RendererDiagnostic {
  readonly code: string
  readonly message: string
  readonly severity?: 'info' | 'warning' | 'error'
  readonly suiteId?: string
  readonly slotId?: string
  readonly kind?: string
}

export interface RendererActivationSnapshot {
  readonly revision: number
  readonly suite: RegistryEntry<RendererSuiteContribution>
  readonly kinds: ReadonlyMap<string, RegistryEntry<RenderKindDefinition>>
  readonly slots: ReadonlyMap<string, readonly RegistryEntry<RendererSlotContribution>[]>
  readonly diagnostics: readonly RendererDiagnostic[]
}
