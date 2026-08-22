import type { WorkbenchAppearanceStore } from '../../domains/workbench/appearance.ts'
import type { SessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'
import type { WorkbenchHostPort } from './workbenchHostPort.ts'
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
export type {
  WorkbenchHostPort,
  WorkbenchCommandPort,
  WorkbenchCommandResult,
  WorkbenchCommandError,
  WorkbenchDocumentReader,
  ResolvedAppearanceReader,
  SessionUiPort,
  WorkbenchCapabilityReader,
  RendererDiagnosticPort,
} from './workbenchHostPort.ts'

export interface SolidWorkbenchServices {
  runtime: WorkbenchRuntime
  appearance: WorkbenchAppearanceStore
  sessionUi: SessionUiStore
  commands: WorkbenchCommandFacade
  /** Stable framework-neutral seam consumed by Suite adapters. */
  hostPort?: WorkbenchHostPort
}

export interface WorkbenchMountInput {
  readonly sheetId: string
  readonly sessionOwnerKey: string | null
  readonly sessionId: string | null
  readonly workspaceMode: 'work' | 'chat'
  readonly replayReadonly: boolean
  readonly reducedMotion: boolean
  readonly visibility: 'active' | 'background'
  readonly rightInset: number
  readonly preview: boolean
}

export interface RendererPrepareContext {
  readonly suiteId: string
  readonly host: WorkbenchHostPort
  readonly activation: RendererActivationSnapshot
}

export interface WorkbenchRendererFactory {
  prepare(context: RendererPrepareContext): Promise<PreparedWorkbenchRenderer>
}

export interface PreparedWorkbenchRenderer {
  mount(
    container: HTMLElement,
    input: WorkbenchMountInput,
    host: WorkbenchHostPort,
  ): Promise<WorkbenchRendererInstance> | WorkbenchRendererInstance
}

export interface WorkbenchRendererInstance {
  update(input: WorkbenchMountInput): void
  pause(): void
  resume(): void
  destroy(): void | Promise<void>
  on(event: 'ready' | 'error' | 'request-action', listener: (payload: unknown) => void): () => void
}

export interface SolidWorkbenchInput {
  sheetId: string
  sessionId: string | null
  replayReadonly?: boolean
  rightInset?: number
  preview?: boolean
  reducedMotion?: boolean
  sessionOwnerKey?: string | null
  workspaceMode?: 'work' | 'chat'
  visibility?: 'active' | 'background'
}

export function normalizeWorkbenchMountInput(input: SolidWorkbenchInput): WorkbenchMountInput {
  return Object.freeze({
    sheetId: input.sheetId,
    sessionOwnerKey: input.sessionOwnerKey ?? null,
    sessionId: input.sessionId,
    workspaceMode: input.workspaceMode ?? 'work',
    replayReadonly: input.replayReadonly === true,
    reducedMotion: input.reducedMotion === true,
    visibility: input.visibility ?? 'active',
    rightInset: Math.max(0, input.rightInset ?? 0),
    preview: input.preview === true,
  })
}

export interface SolidWorkbenchLifecycle {
  update(input: SolidWorkbenchInput): void
  pause(): void
  resume(): void
  destroy(): void | Promise<void>
  on(event: 'ready' | 'error' | 'request-action', listener: (payload: unknown) => void): () => void
}

export interface SolidWorkbenchMountInput {
  host: HTMLElement
  input: SolidWorkbenchInput
  services: SolidWorkbenchServices
  hostPort?: WorkbenchHostPort
}
