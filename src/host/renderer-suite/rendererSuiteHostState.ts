export type RendererSuiteHostPhase = 'idle' | 'preparing' | 'mounting-candidate' | 'active' | 'switching' | 'degraded' | 'destroyed'

export interface RendererSuiteHostState {
  readonly phase: RendererSuiteHostPhase
  readonly suiteId?: string
  readonly previousSuiteId?: string
  readonly registryRevision?: number
  readonly documentRevision?: number
  readonly error?: unknown
}

export function createRendererSuiteHostState(
  phase: RendererSuiteHostPhase = 'idle',
  patch: Omit<RendererSuiteHostState, 'phase'> = {},
): RendererSuiteHostState {
  return Object.freeze({ phase, ...patch })
}
