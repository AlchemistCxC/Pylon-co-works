export type CancelStatus =
  | 'idle'
  | 'generating'
  | 'canceling'
  | 'cancelled'
  | 'error'

export type CancelState = {
  source: string
  status: CancelStatus
  error?: string
}

export type CancelEvent =
  | { kind: 'success' }
  | { kind: 'error'; error: string }

export type CancelBeginResult = {
  state: CancelState
  shouldInvoke: boolean
}

export function createCancelState(source: string): CancelState {
  return { source, status: 'idle' }
}

function sameSource(source: string, state: CancelState): boolean {
  return source.length > 0 && source === state.source
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'Cancel request failed'
}

export function beginCancel(source: string, state: CancelState): CancelBeginResult {
  if (!sameSource(source, state) || state.status !== 'generating') {
    return { state, shouldInvoke: false }
  }

  return {
    state: { source: state.source, status: 'canceling' },
    shouldInvoke: true,
  }
}

export function resolveCancelCommand(source: string, state: CancelState): CancelState {
  return sameSource(source, state) ? state : state
}

export function rejectCancelCommand(
  source: string,
  state: CancelState,
  error: unknown,
): CancelState {
  if (!sameSource(source, state) || state.status !== 'canceling') return state
  return {
    source: state.source,
    status: 'generating',
    error: errorMessage(error),
  }
}

export function applyCancelEvent(
  source: string,
  event: CancelEvent,
  state: CancelState,
): CancelState {
  if (!sameSource(source, state) || state.status !== 'canceling') return state

  if (event.kind === 'success') {
    return { source: state.source, status: 'cancelled' }
  }

  return {
    source: state.source,
    status: 'generating',
    error: event.error,
  }
}
