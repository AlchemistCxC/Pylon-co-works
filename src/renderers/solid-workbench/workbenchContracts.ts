import type { WorkbenchAppearanceStore } from '../../domains/workbench/appearance.ts'
import type { SessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'

export interface SolidWorkbenchServices {
  runtime: WorkbenchRuntime
  appearance: WorkbenchAppearanceStore
  sessionUi: SessionUiStore
  commands: WorkbenchCommandFacade
}

export interface SolidWorkbenchInput {
  sheetId: string
  sessionId: string | null
  replayReadonly?: boolean
  rightInset?: number
  preview?: boolean
  reducedMotion?: boolean
}

export interface SolidWorkbenchLifecycle {
  update(input: SolidWorkbenchInput): void
  pause(): void
  resume(): void
  destroy(): void
}

export interface SolidWorkbenchMountInput {
  host: HTMLElement
  input: SolidWorkbenchInput
  services: SolidWorkbenchServices
}
