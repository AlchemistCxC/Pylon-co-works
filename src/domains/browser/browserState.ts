/**
 * browserState — browser 前端状态机（W4-03）。
 *
 * idle/starting/ready/error；单实例（重复 start 只发一次 invoke——守卫断言）；
 * 导航/后退/前进/刷新接口占位。CDP 命令契约未定——不虚构命令名（壳先行，W4-04
 * 接真实契约）。
 */

export type BrowserPhase = 'idle' | 'starting' | 'ready' | 'error'

export interface BrowserState {
  phase: BrowserPhase
  error?: string
  instanceId?: string
}

export type BrowserAction =
  | { type: 'start' }
  | { type: 'started'; instanceId?: string }
  | { type: 'failed'; error: string }
  | { type: 'stop' }

export function createBrowserState(): BrowserState {
  return { phase: 'idle' }
}

export function browserReducer(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case 'start':
      return state.phase === 'idle' || state.phase === 'error' ? { ...state, phase: 'starting', error: undefined } : state
    case 'started':
      return state.phase === 'starting' ? { ...state, phase: 'ready', instanceId: action.instanceId } : state
    case 'failed':
      return state.phase === 'starting' ? { ...state, phase: 'error', error: action.error } : state
    case 'stop':
      return state.phase === 'ready' ? { ...state, phase: 'idle' } : state
  }
}
