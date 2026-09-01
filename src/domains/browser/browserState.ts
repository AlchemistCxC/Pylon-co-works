/**
 * browserState — browser 前端状态机（W4-03）。
 *
 * idle/starting/ready/error；浏览器的标签、导航和页面交互由 BrowserClient/Tauri
 * manager 负责，这里只保留 Sheet 壳的生命周期状态，避免把 WebView 细节带进渲染层。
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
