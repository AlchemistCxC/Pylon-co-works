import { createContext, useContext, type Accessor } from 'solid-js'
import type { WorkbenchAppearanceSnapshot, WorkbenchAppearanceStore } from '../../domains/workbench/appearance.ts'
import type { SessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchSessionCreationReader } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchRuntime, WorkbenchRuntimeSnapshot } from '../../domains/workbench/workbenchRuntime.ts'
import type { SolidWorkbenchInput } from './workbenchContracts.ts'
import type { WorkbenchHostPort } from './workbenchHostPort.ts'
import type { RendererActivationSnapshot } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { InputPredictionProvider } from './input/inputPredictionProvider.ts'

export interface SolidWorkbenchContextValue {
  input: Accessor<SolidWorkbenchInput>
  runtime: WorkbenchRuntime
  runtimeSnapshot: Accessor<WorkbenchRuntimeSnapshot>
  appearance: WorkbenchAppearanceStore
  appearanceSnapshot: Accessor<WorkbenchAppearanceSnapshot>
  sessionUi: SessionUiStore
  commands: WorkbenchCommandFacade
  /** Host-owned, display-only creation phase reader. */
  sessionCreation?: WorkbenchSessionCreationReader
  /** Present for mounted Suite adapters; legacy unit fixtures may omit it. */
  hostPort?: WorkbenchHostPort
  paused: Accessor<boolean>
  /**
   * #212 判据 C：本次会话里被观察到「文本在两次发布之间变长」的行 key
   * （`streamRowKey(id, role)`）——渲染层据此把该行留在增量（graft）路径上。
   * 只读、由显示调度器驱动；**缺省时渲染层只用权威活性判据**（legacy 夹具零改动）。
   */
  revealingRows?: Accessor<ReadonlySet<string>>
  reportRendererError?(error: unknown): void
  reportRendererAction?(action: unknown): void
  activation?: RendererActivationSnapshot
  /** Optional host-owned local/remote provider for low-frequency input prediction. */
  predictionProvider?: InputPredictionProvider
}

export const SolidWorkbenchContext = createContext<SolidWorkbenchContextValue>()

export function useSolidWorkbench(): SolidWorkbenchContextValue {
  const value = useContext(SolidWorkbenchContext)
  if (!value) throw new Error('SolidWorkbenchContext 未提供')
  return value
}
