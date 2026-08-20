import { createContext, useContext, type Accessor } from 'solid-js'
import type { WorkbenchAppearanceSnapshot, WorkbenchAppearanceStore } from '../../domains/workbench/appearance.ts'
import type { SessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchRuntime, WorkbenchRuntimeSnapshot } from '../../domains/workbench/workbenchRuntime.ts'
import type { SolidWorkbenchInput } from './workbenchContracts.ts'

export interface SolidWorkbenchContextValue {
  input: Accessor<SolidWorkbenchInput>
  runtime: WorkbenchRuntime
  runtimeSnapshot: Accessor<WorkbenchRuntimeSnapshot>
  appearance: WorkbenchAppearanceStore
  appearanceSnapshot: Accessor<WorkbenchAppearanceSnapshot>
  sessionUi: SessionUiStore
  commands: WorkbenchCommandFacade
  paused: Accessor<boolean>
}

export const SolidWorkbenchContext = createContext<SolidWorkbenchContextValue>()

export function useSolidWorkbench(): SolidWorkbenchContextValue {
  const value = useContext(SolidWorkbenchContext)
  if (!value) throw new Error('SolidWorkbenchContext 未提供')
  return value
}
