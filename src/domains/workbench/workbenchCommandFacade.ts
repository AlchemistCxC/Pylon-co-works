export interface WorkbenchAttachment {
  id: string
  path: string
  name?: string
  mediaType?: string
}

export interface SendCommand {
  text: string
  attachments?: readonly WorkbenchAttachment[]
  queueIfGenerating?: boolean
}

export interface SendResult {
  status: 'sent' | 'queued' | 'rejected'
  messageId?: string
  error?: string
}

export interface CancelResult {
  status: 'cancelled' | 'not-generating' | 'rejected'
  error?: string
}

export interface CommandResult {
  ok: boolean
  error?: string
}

/**
 * Display-only lifecycle for an empty-state session creation request.
 *
 * Session selection and the first prompt intentionally have different
 * completion boundaries: selecting the local session ends the empty-state
 * creation animation, while the prompt continues through the normal
 * generation footer.  This reader keeps that distinction observable without
 * putting UI state in the canonical journal.
 */
export type WorkbenchSessionCreationPhase =
  | 'idle'
  | 'creating-session'
  | 'session-selected'
  | 'prompt-running'
  | 'prompt-terminal'
  | 'creation-failed'

export interface WorkbenchSessionCreationSnapshot {
  readonly phase: WorkbenchSessionCreationPhase
  readonly sessionId: string | null
  readonly error: string | null
  readonly attempt: number
}

export interface WorkbenchSessionCreationReader {
  getSnapshot(): WorkbenchSessionCreationSnapshot
  subscribe(listener: () => void): () => void
}

export interface WorkbenchSessionCreationStore extends WorkbenchSessionCreationReader {
  begin(): number
  markSessionSelected(attempt: number, sessionId: string): void
  markPromptRunning(attempt: number, sessionId: string): void
  markPromptTerminal(attempt: number, sessionId: string): void
  markFailed(attempt: number, error: string, sessionId?: string | null): void
}

/** Create a small ephemeral lifecycle store for command/UI coordination. */
export function createWorkbenchSessionCreationStore(): WorkbenchSessionCreationStore {
  let snapshot: WorkbenchSessionCreationSnapshot = Object.freeze({
    phase: 'idle', sessionId: null, error: null, attempt: 0,
  })
  const listeners = new Set<() => void>()
  const publish = (next: WorkbenchSessionCreationSnapshot) => {
    snapshot = Object.freeze(next)
    for (const listener of [...listeners]) listener()
  }
  const transition = (
    attempt: number,
    phase: WorkbenchSessionCreationPhase,
    sessionId: string | null,
    error: string | null = null,
  ) => {
    if (attempt !== snapshot.attempt) return
    if (snapshot.phase === phase && snapshot.sessionId === sessionId && snapshot.error === error) return
    publish({ phase, sessionId, error, attempt })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    begin() {
      const attempt = snapshot.attempt + 1
      publish({ phase: 'creating-session', sessionId: null, error: null, attempt })
      return attempt
    },
    markSessionSelected(attempt, sessionId) {
      transition(attempt, 'session-selected', sessionId)
    },
    markPromptRunning(attempt, sessionId) {
      transition(attempt, 'prompt-running', sessionId)
    },
    markPromptTerminal(attempt, sessionId) {
      transition(attempt, 'prompt-terminal', sessionId)
    },
    markFailed(attempt, error, sessionId = snapshot.sessionId) {
      transition(attempt, 'creation-failed', sessionId, error)
    },
  }
}

export interface WorkbenchCommandCapabilities {
  readonly prompt?: boolean
  readonly cancel?: boolean
  readonly toolAction?: boolean
  readonly interactionResponse?: boolean
  readonly resourceOpen?: boolean
  readonly resourceReveal?: boolean
  readonly clipboardWrite?: boolean
  readonly retry?: boolean
  readonly recovery?: boolean
  readonly sessionConfig?: boolean
}

export interface SessionCreateInput {
  title?: string
  profileId?: string
  workspaceId?: string
  model?: string
  reasoningLevel?: string
  mode?: string
  initialPrompt?: SendCommand
}

export interface SessionCreateResult {
  readonly sessionId: string
  /** Settles independently after the session-selected boundary. */
  readonly initialPromptOutcome?: Promise<SendResult>
}

export interface ExportSessionInput {
  format: 'json' | 'markdown'
  destination?: string
}

export interface WorkbenchCommandFacade {
  /** Optional host-owned reader for the empty-state creation lifecycle. */
  readonly sessionCreation?: WorkbenchSessionCreationReader
  /** Semantic prompt command; send remains as a compatibility alias. */
  prompt(sessionId: string, command: SendCommand): Promise<SendResult>
  send(sessionId: string, command: SendCommand): Promise<SendResult>
  cancel(sessionId: string): Promise<CancelResult>
  attach(sessionId: string): Promise<readonly WorkbenchAttachment[]>
  setModel(sessionId: string, modelId: string): Promise<CommandResult>
  setMode(sessionId: string, modeId: string): Promise<CommandResult>
  createSession(input?: SessionCreateInput): Promise<SessionCreateResult>
  compact(sessionId: string): Promise<CommandResult>
  exportSession(sessionId: string, input: ExportSessionInput): Promise<CommandResult>
  clearSession(sessionId: string): Promise<CommandResult>
  setConfigOption(sessionId: string, key: string, value: unknown,
    options?: { expectedValue?: unknown; expectedVersion?: number }): Promise<CommandResult>
  toolAction(sessionId: string, toolCallId: string, action: string, payload?: unknown): Promise<CommandResult>
  /** C11/A09 补全：expectedRevision 供 transport 层做 stale 写入防护（可省略，向后兼容）。 */
  respondInteraction(sessionId: string, interactionId: string, response: unknown,
    options?: { expectedRevision?: number }): Promise<CommandResult>
  openResource(sessionId: string, resource: unknown): Promise<CommandResult>
  revealResource(sessionId: string, resource: unknown): Promise<CommandResult>
  copy(sessionId: string, text: string): Promise<CommandResult>
  retry(sessionId: string, messageId?: string): Promise<CommandResult>
  recover(sessionId: string, strategy?: string): Promise<CommandResult>
}

/** Keys whose values are callable command methods (excludes optional readers). */
export type WorkbenchCommandMethodKey = {
  [K in keyof WorkbenchCommandFacade]-?: WorkbenchCommandFacade[K] extends (...args: infer _Args) => infer _Result ? K : never
}[keyof WorkbenchCommandFacade]

export interface WorkbenchCommandCall {
  command: WorkbenchCommandMethodKey
  args: readonly unknown[]
}

export interface FakeWorkbenchCommandFacade extends WorkbenchCommandFacade {
  readonly calls: readonly WorkbenchCommandCall[]
  setHandler<K extends WorkbenchCommandMethodKey>(
    command: K,
    handler: WorkbenchCommandFacade[K],
  ): void
  reset(): void
}

const defaultHandlers: WorkbenchCommandFacade = {
  async prompt() {
    return { status: 'sent' }
  },
  async send() {
    return { status: 'sent' }
  },
  async cancel() {
    return { status: 'cancelled' }
  },
  async attach() {
    return []
  },
  async setModel() {
    return { ok: true }
  },
  async setMode() {
    return { ok: true }
  },
  async createSession() {
    return { sessionId: 'preview-session' }
  },
  async compact() {
    return { ok: true }
  },
  async exportSession() {
    return { ok: true }
  },
  async clearSession() {
    return { ok: true }
  },
  async setConfigOption() { return { ok: true } },
  async toolAction() { return { ok: true } },
  async respondInteraction() { return { ok: true } },
  async openResource() { return { ok: true } },
  async revealResource() { return { ok: true } },
  async copy() { return { ok: true } },
  async retry() { return { ok: true } },
  async recover() { return { ok: true } },
}

export function createCapabilityGatedWorkbenchCommandFacade(
  delegate: WorkbenchCommandFacade,
  capabilities: WorkbenchCommandCapabilities,
): WorkbenchCommandFacade {
  const denied = async (): Promise<CommandResult> => ({ ok: false, error: 'command_capability_denied' })
  return {
    ...delegate,
    prompt: (sessionId, command) => capabilities.prompt === false ? Promise.resolve({ status: 'rejected', error: 'command_capability_denied' }) : delegate.prompt(sessionId, command),
    send: (sessionId, command) => capabilities.prompt === false ? Promise.resolve({ status: 'rejected', error: 'command_capability_denied' }) : delegate.send(sessionId, command),
    cancel: sessionId => capabilities.cancel === false ? Promise.resolve({ status: 'rejected', error: 'command_capability_denied' }) : delegate.cancel(sessionId),
    setConfigOption: (sessionId, key, value, options) => capabilities.sessionConfig === false
      ? denied() : delegate.setConfigOption(sessionId, key, value, options),
    toolAction: (sessionId, toolCallId, action, payload) => capabilities.toolAction === false ? denied() : delegate.toolAction(sessionId, toolCallId, action, payload),
    respondInteraction: (sessionId, interactionId, response, options) => capabilities.interactionResponse === false ? denied() : delegate.respondInteraction(sessionId, interactionId, response, options),
    openResource: (sessionId, resource) => capabilities.resourceOpen === false ? denied() : delegate.openResource(sessionId, resource),
    revealResource: (sessionId, resource) => capabilities.resourceReveal === false ? denied() : delegate.revealResource(sessionId, resource),
    copy: (sessionId, text) => capabilities.clipboardWrite === false ? denied() : delegate.copy(sessionId, text),
    retry: (sessionId, messageId) => capabilities.retry === false ? denied() : delegate.retry(sessionId, messageId),
    recover: (sessionId, strategy) => capabilities.recovery === false ? denied() : delegate.recover(sessionId, strategy),
  }
}

export function createFakeWorkbenchCommandFacade(
  overrides: Partial<WorkbenchCommandFacade> = {},
): FakeWorkbenchCommandFacade {
  const calls: WorkbenchCommandCall[] = []
  const handlers: WorkbenchCommandFacade = { ...defaultHandlers, ...overrides }
  const sessionCreation = createWorkbenchSessionCreationStore()

  const invoke = async <K extends WorkbenchCommandMethodKey>(
    command: K,
    args: Parameters<WorkbenchCommandFacade[K]>,
  ): Promise<Awaited<ReturnType<WorkbenchCommandFacade[K]>>> => {
    calls.push({ command, args })
    const handler = handlers[command] as (...values: Parameters<WorkbenchCommandFacade[K]>) => ReturnType<WorkbenchCommandFacade[K]>
    if (command === 'createSession') {
      const attempt = sessionCreation.begin()
      try {
        const result = await handler(...args) as Awaited<ReturnType<WorkbenchCommandFacade[K]>>
        const sessionId = result && typeof result === 'object' && 'sessionId' in result
          && typeof (result as { sessionId?: unknown }).sessionId === 'string'
          ? (result as { sessionId: string }).sessionId
          : ''
        if (sessionId) {
          sessionCreation.markSessionSelected(attempt, sessionId)
          const input = args[0] as SessionCreateInput | undefined
          if (input?.initialPrompt) sessionCreation.markPromptRunning(attempt, sessionId)
          else sessionCreation.markPromptTerminal(attempt, sessionId)
        } else {
          sessionCreation.markFailed(attempt, '会话创建未返回有效标识', null)
        }
        return result
      } catch (error) {
        sessionCreation.markFailed(attempt, error instanceof Error ? error.message : String(error), null)
        throw error
      }
    }
    return await handler(...args) as Awaited<ReturnType<WorkbenchCommandFacade[K]>>
  }

  return {
    sessionCreation,
    get calls() {
      return calls
    },
    prompt: (sessionId, command) => invoke('prompt', [sessionId, command]),
    send: (sessionId, command) => invoke('send', [sessionId, command]),
    cancel: sessionId => invoke('cancel', [sessionId]),
    attach: sessionId => invoke('attach', [sessionId]),
    setModel: (sessionId, modelId) => invoke('setModel', [sessionId, modelId]),
    setMode: (sessionId, modeId) => invoke('setMode', [sessionId, modeId]),
    createSession: input => invoke('createSession', [input]),
    compact: sessionId => invoke('compact', [sessionId]),
    exportSession: (sessionId, input) => invoke('exportSession', [sessionId, input]),
    clearSession: sessionId => invoke('clearSession', [sessionId]),
    setConfigOption: (sessionId, key, value, options) => invoke('setConfigOption', [sessionId, key, value, options ?? undefined]),
    toolAction: (sessionId, toolCallId, action, payload) => invoke('toolAction', [sessionId, toolCallId, action, payload]),
    respondInteraction: (sessionId, interactionId, response, options) => invoke('respondInteraction', [sessionId, interactionId, response, options ?? undefined]),
    openResource: (sessionId, resource) => invoke('openResource', [sessionId, resource]),
    revealResource: (sessionId, resource) => invoke('revealResource', [sessionId, resource]),
    copy: (sessionId, text) => invoke('copy', [sessionId, text]),
    retry: (sessionId, messageId) => invoke('retry', [sessionId, messageId]),
    recover: (sessionId, strategy) => invoke('recover', [sessionId, strategy]),
    setHandler(command, handler) {
      handlers[command] = handler
    },
    reset() {
      calls.length = 0
    },
  }
}
