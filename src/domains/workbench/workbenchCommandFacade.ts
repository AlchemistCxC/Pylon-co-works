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

export interface SessionCreateInput {
  title?: string
  profileId?: string
}

export interface ExportSessionInput {
  format: 'json' | 'markdown'
  destination?: string
}

export interface WorkbenchCommandFacade {
  send(sessionId: string, command: SendCommand): Promise<SendResult>
  cancel(sessionId: string): Promise<CancelResult>
  attach(sessionId: string): Promise<readonly WorkbenchAttachment[]>
  setModel(sessionId: string, modelId: string): Promise<CommandResult>
  setMode(sessionId: string, modeId: string): Promise<CommandResult>
  createSession(input?: SessionCreateInput): Promise<{ sessionId: string }>
  compact(sessionId: string): Promise<CommandResult>
  exportSession(sessionId: string, input: ExportSessionInput): Promise<CommandResult>
  clearSession(sessionId: string): Promise<CommandResult>
}

export interface WorkbenchCommandCall {
  command: keyof WorkbenchCommandFacade
  args: readonly unknown[]
}

export interface FakeWorkbenchCommandFacade extends WorkbenchCommandFacade {
  readonly calls: readonly WorkbenchCommandCall[]
  setHandler<K extends keyof WorkbenchCommandFacade>(
    command: K,
    handler: WorkbenchCommandFacade[K],
  ): void
  reset(): void
}

const defaultHandlers: WorkbenchCommandFacade = {
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
}

export function createFakeWorkbenchCommandFacade(
  overrides: Partial<WorkbenchCommandFacade> = {},
): FakeWorkbenchCommandFacade {
  const calls: WorkbenchCommandCall[] = []
  const handlers: WorkbenchCommandFacade = { ...defaultHandlers, ...overrides }

  const invoke = async <K extends keyof WorkbenchCommandFacade>(
    command: K,
    args: Parameters<WorkbenchCommandFacade[K]>,
  ): Promise<Awaited<ReturnType<WorkbenchCommandFacade[K]>>> => {
    calls.push({ command, args })
    const handler = handlers[command] as (...values: Parameters<WorkbenchCommandFacade[K]>) => ReturnType<WorkbenchCommandFacade[K]>
    return await handler(...args) as Awaited<ReturnType<WorkbenchCommandFacade[K]>>
  }

  return {
    get calls() {
      return calls
    },
    send: (sessionId, command) => invoke('send', [sessionId, command]),
    cancel: sessionId => invoke('cancel', [sessionId]),
    attach: sessionId => invoke('attach', [sessionId]),
    setModel: (sessionId, modelId) => invoke('setModel', [sessionId, modelId]),
    setMode: (sessionId, modeId) => invoke('setMode', [sessionId, modeId]),
    createSession: input => invoke('createSession', [input]),
    compact: sessionId => invoke('compact', [sessionId]),
    exportSession: (sessionId, input) => invoke('exportSession', [sessionId, input]),
    clearSession: sessionId => invoke('clearSession', [sessionId]),
    setHandler(command, handler) {
      handlers[command] = handler
    },
    reset() {
      calls.length = 0
    },
  }
}
