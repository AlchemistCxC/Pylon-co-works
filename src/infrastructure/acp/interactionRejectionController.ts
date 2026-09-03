import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'

export interface InteractionRejection {
  provider: string
  agentId?: string
  sessionId?: string
  requestId?: string
  method?: string
  reasonCode: string
  message: string
  rpcCode?: number
  responseSent: boolean
}

export interface InteractionRejectionControllerDeps {
  listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Normalize the redacted host event without accepting arbitrary provider params. */
export function normalizeInteractionRejection(value: unknown): InteractionRejection | null {
  if (!isRecord(value)) return null
  const provider = stringValue(value.provider)
  const reasonCode = stringValue(value.reasonCode ?? value.reason_code)
  const message = stringValue(value.message)
  if (!provider || !reasonCode || !message) return null
  const rpcCode = typeof value.rpcCode === 'number'
    ? value.rpcCode
    : typeof value.rpc_code === 'number' ? value.rpc_code : undefined
  return {
    provider,
    agentId: stringValue(value.agentId ?? value.agent_id),
    sessionId: stringValue(value.sessionId ?? value.session_id),
    requestId: stringValue(value.requestId ?? value.request_id),
    method: stringValue(value.method),
    reasonCode,
    message,
    ...(rpcCode !== undefined ? { rpcCode } : {}),
    responseSent: value.responseSent === true || value.response_sent === true,
  }
}

/**
 * Listen to host-side interaction rejections.  Rejections intentionally bypass the
 * permission reducer: they are not actionable requests.  We still report them to the
 * runtime error center and fan out a short-lived UI notice through a DOM event so the
 * component remains independent from Tauri in tests and browser preview.
 */
export function createInteractionRejectionController(
  deps: InteractionRejectionControllerDeps,
): { dispose: () => Promise<void> } {
  let disposed = false
  let unlisten: (() => void) | null = null
  let lastFingerprint = ''
  let lastAt = 0

  const onPayload = (payload: unknown) => {
    if (disposed) return
    const rejection = normalizeInteractionRejection(payload)
    if (!rejection) return
    // Tauri can replay an event while a WebView is being reattached.  Avoid doubling
    // the toast/error badge for an identical rejection in the same short window.
    const fingerprint = `${rejection.provider}|${rejection.agentId ?? ''}|${rejection.requestId ?? ''}|${rejection.reasonCode}|${rejection.message}`
    const now = Date.now()
    if (fingerprint === lastFingerprint && now - lastAt < 1500) return
    lastFingerprint = fingerprint
    lastAt = now
    reportRuntimeError('处理 Agent 交互请求', {
      code: `interaction_${rejection.reasonCode}`,
      message: rejection.message,
    }, rejection.agentId, {
      source: 'acp.interaction',
      scope: rejection.sessionId
        ? { kind: 'session', id: rejection.sessionId }
        : rejection.agentId ? { kind: 'agent', id: rejection.agentId } : { kind: 'app', id: 'interaction' },
      recovery: { kind: 'open-runtime-log', sessionId: rejection.sessionId },
    })
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<InteractionRejection>('pylon:interaction-rejected', { detail: rejection }))
    }
  }

  deps.listen<unknown>('pylon:interaction-rejected', event => onPayload(event.payload)).then(stop => {
    if (disposed) stop()
    else {
      unlisten = stop
      resolveRuntimeErrors({ key: 'acp:interaction-listener' })
    }
  }).catch(error => {
    // Listener setup can reject after the owning App has unmounted (for
    // example during a StrictMode/remount probe). Do not surface that stale
    // transport rejection as a fresh user error.
    if (!disposed) reportRuntimeError('监听交互拒绝事件', error, undefined, {
      key: 'acp:interaction-listener',
      scope: { kind: 'app', id: 'interaction' },
      source: 'acp.interaction',
      recovery: { kind: 'open-runtime-log' },
    })
  })

  return {
    dispose: async () => {
      if (disposed) return
      disposed = true
      if (unlisten) {
        const stop = unlisten
        unlisten = null
        stop()
      }
    },
  }
}
