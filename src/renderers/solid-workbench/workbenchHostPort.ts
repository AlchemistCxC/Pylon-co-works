import type { WorkbenchAppearanceSnapshot, WorkbenchAppearanceStore } from '../../domains/workbench/appearance.ts'
import type { SessionUiKey, SessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchCommandFacade, SendCommand, SendResult, CancelResult, WorkbenchAttachment, SessionCreateInput, ExportSessionInput, CommandResult } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchDocument, WorkbenchMessage, WorkbenchActivityNode, WorkbenchInteraction, WorkbenchTimelineEntry } from '../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchRuntime, WorkbenchRuntimeSlice } from '../../domains/workbench/workbenchRuntime.ts'
import type { RenderAppearanceSnapshot } from '../../contracts/messageRenderer.ts'

export type WorkbenchDocumentSlice = 'document' | 'timeline' | 'messages' | 'activities' | 'interactions' | 'session' | 'usage' | 'diagnostics'

export interface WorkbenchDocumentReader {
  getSnapshot(): WorkbenchDocument | undefined
  subscribe(listener: () => void): () => void
  getSlice<T = unknown>(slice: WorkbenchDocumentSlice): T
  subscribeSlice(slice: WorkbenchDocumentSlice, listener: () => void): () => void
}

export interface ResolvedAppearanceReader {
  getSnapshot(): WorkbenchAppearanceSnapshot
  subscribe(listener: () => void): () => void
  resolve?(request: { readonly kind: string; readonly suiteId: string; readonly slotId: string }): RenderAppearanceSnapshot
}

export interface SessionUiPort {
  get<T>(key: SessionUiKey, fallback: T): T
  set<T>(key: SessionUiKey, value: T): void
  update<T>(key: SessionUiKey, fallback: T, updater: (previous: T) => T): T
  subscribe(key: SessionUiKey, listener: () => void): () => void
  clear(): void
}

export type WorkbenchCapability = 'prompt' | 'cancel' | 'attach' | 'model' | 'mode'
  | 'sessionCreate' | 'compact' | 'sessionExport' | 'sessionClear'
  | 'toolAction' | 'interactionResponse' | 'resourceOpen' | 'resourceReveal'
  | 'clipboardWrite' | 'retry' | 'recovery'
export type WorkbenchCapabilitySnapshot = Readonly<Partial<Record<WorkbenchCapability, boolean>>>

export interface WorkbenchCapabilityReader {
  getSnapshot(): WorkbenchCapabilitySnapshot
  has(capability: WorkbenchCapability): boolean
  subscribe(listener: () => void): () => void
}

export type WorkbenchRecoverability = 'retry' | 'fallback' | 'reload-plugin' | 'reimport' | 'none'

export interface WorkbenchCommandError {
  readonly code: string
  readonly message: string
  readonly recoverability: WorkbenchRecoverability
  readonly capability?: WorkbenchCapability
}

export type WorkbenchCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkbenchCommandError }

export interface WorkbenchCommandPort {
  prompt(sessionId: string, command: SendCommand): Promise<WorkbenchCommandResult<SendResult>>
  send(sessionId: string, command: SendCommand): Promise<WorkbenchCommandResult<SendResult>>
  cancel(sessionId: string): Promise<WorkbenchCommandResult<CancelResult>>
  attach(sessionId: string): Promise<WorkbenchCommandResult<readonly WorkbenchAttachment[]>>
  setModel(sessionId: string, modelId: string): Promise<WorkbenchCommandResult<CommandResult>>
  setMode(sessionId: string, modeId: string): Promise<WorkbenchCommandResult<CommandResult>>
  createSession(input?: SessionCreateInput): Promise<WorkbenchCommandResult<{ sessionId: string }>>
  compact(sessionId: string): Promise<WorkbenchCommandResult<CommandResult>>
  exportSession(sessionId: string, input: ExportSessionInput): Promise<WorkbenchCommandResult<CommandResult>>
  clearSession(sessionId: string): Promise<WorkbenchCommandResult<CommandResult>>
  toolAction(sessionId: string, toolCallId: string, action: string, payload?: unknown): Promise<WorkbenchCommandResult<CommandResult>>
  respondInteraction(sessionId: string, interactionId: string, response: unknown,
    options?: { expectedRevision?: number }): Promise<WorkbenchCommandResult<CommandResult>>
  openResource(sessionId: string, resource: unknown): Promise<WorkbenchCommandResult<CommandResult>>
  revealResource(sessionId: string, resource: unknown): Promise<WorkbenchCommandResult<CommandResult>>
  copy(sessionId: string, text: string): Promise<WorkbenchCommandResult<CommandResult>>
  retry(sessionId: string, messageId?: string): Promise<WorkbenchCommandResult<CommandResult>>
  recover(sessionId: string, strategy?: string): Promise<WorkbenchCommandResult<CommandResult>>
}

export interface RendererDiagnosticContext {
  readonly code: string
  readonly message: string
  readonly phase?: 'resolve' | 'prepare' | 'mount' | 'update' | 'switch' | 'action' | 'destroy' | 'settings-migrate'
  readonly pluginId?: string
  readonly runtimeInstanceId?: string
  readonly suiteId?: string
  readonly slotId?: string
  readonly kind?: string
  readonly eventId?: string
  readonly sessionId?: string | null
  readonly recoverability?: WorkbenchRecoverability
  readonly [key: string]: unknown
}

export interface RendererDiagnosticPort {
  report(diagnostic: RendererDiagnosticContext): void
  getRecent(): readonly RendererDiagnosticContext[]
  subscribe(listener: () => void): () => void
  destroy?(): void
}

export interface WorkbenchHostPort {
  readonly document: WorkbenchDocumentReader
  readonly appearance: ResolvedAppearanceReader
  readonly sessionUi: SessionUiPort
  readonly commands: WorkbenchCommandPort
  readonly capabilities: WorkbenchCapabilityReader
  readonly diagnostics: RendererDiagnosticPort
}

export interface WorkbenchHostPortInput {
  readonly runtime: WorkbenchRuntime
  readonly appearance: WorkbenchAppearanceStore
  readonly sessionUi: SessionUiStore
  readonly commands: WorkbenchCommandFacade
  readonly suiteId: string
  readonly sheetId: string
  readonly sessionOwnerKey: string | null
  readonly sessionId: string | null
  readonly capabilities?: WorkbenchCapabilitySnapshot
  readonly diagnostics?: ((diagnostic: RendererDiagnosticContext) => void) | Pick<RendererDiagnosticPort, 'report'>
  readonly renderAppearance?: {
    resolve(request: { readonly kind: string; readonly suiteId: string; readonly slotId: string }, host: WorkbenchAppearanceSnapshot): RenderAppearanceSnapshot
    subscribe(listener: () => void): () => void
  }
  /** Stable Host Port may follow session/Suite changes without replacing renderer instances. */
  readonly binding?: () => {
    readonly suiteId?: string
    readonly sheetId: string
    readonly sessionOwnerKey: string | null
    readonly sessionId: string | null
  }
}

function mapDocumentSlice(slice: WorkbenchDocumentSlice): WorkbenchRuntimeSlice {
  return slice
}

function createDocumentReader(runtime: WorkbenchRuntime): WorkbenchDocumentReader {
  return {
    getSnapshot: () => runtime.getSnapshot().document,
    subscribe: listener => runtime.subscribe(listener),
    getSlice: slice => runtime.getSlice(mapDocumentSlice(slice)),
    subscribeSlice: (slice, listener) => runtime.subscribeSlice(mapDocumentSlice(slice), listener),
  }
}

function createAppearanceReader(input: WorkbenchHostPortInput): ResolvedAppearanceReader {
  let revision = 0
  const getSnapshot = () => Object.freeze({ ...input.appearance.getSnapshot(), rendererSettingsRevision: revision })
  return {
    getSnapshot,
    subscribe(listener) {
      const notify = () => { revision += 1; listener() }
      const unsubscribeHost = input.appearance.subscribe(notify)
      const unsubscribeRenderer = input.renderAppearance?.subscribe(notify) ?? (() => {})
      return () => { unsubscribeHost(); unsubscribeRenderer() }
    },
    resolve: input.renderAppearance
      ? request => input.renderAppearance!.resolve(request, getSnapshot())
      : undefined,
  }
}

function createSessionUiPort(store: SessionUiStore, namespace: () => string): SessionUiPort {
  return {
    get: (key, fallback) => store.get(namespace(), key, fallback),
    set: (key, value) => store.set(namespace(), key, value),
    update: (key, fallback, updater) => store.update(namespace(), key, fallback, updater),
    subscribe: (key, listener) => store.subscribe(namespace(), key, listener),
    clear: () => store.clear(namespace()),
  }
}

const capabilityForCommand: Readonly<Record<keyof WorkbenchCommandPort, WorkbenchCapability>> = {
  prompt: 'prompt', send: 'prompt', cancel: 'cancel', attach: 'attach', setModel: 'model', setMode: 'mode',
  createSession: 'sessionCreate', compact: 'compact', exportSession: 'sessionExport', clearSession: 'sessionClear', toolAction: 'toolAction',
  respondInteraction: 'interactionResponse', openResource: 'resourceOpen', revealResource: 'resourceReveal', copy: 'clipboardWrite', retry: 'retry', recover: 'recovery',
}

function createCommandPort(delegate: WorkbenchCommandFacade, capabilities: WorkbenchCapabilityReader): WorkbenchCommandPort {
  const invoke = async <K extends keyof WorkbenchCommandPort>(command: K, args: readonly unknown[]): Promise<WorkbenchCommandResult<unknown>> => {
    const capability = capabilityForCommand[command]
    if (!capabilities.has(capability)) return { ok: false, error: { code: 'command_capability_denied', message: `命令能力未授权：${capability}`, recoverability: 'none', capability } }
    try {
      const method = delegate[command] as (...values: readonly unknown[]) => Promise<unknown>
      const result = await method(...args)
      if (result && typeof result === 'object' && 'status' in result && result.status === 'rejected') {
        return { ok: false, error: { code: 'command_rejected', message: '命令被运行时拒绝', recoverability: 'none' } }
      }
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        const error = 'error' in result ? (result as { error?: unknown }).error : undefined
        return { ok: false, error: { code: 'command_rejected', message: typeof error === 'string' ? error : '命令被运行时拒绝', recoverability: 'retry' } }
      }
      return { ok: true, value: result }
    } catch (error) {
      return { ok: false, error: { code: 'command_failed', message: error instanceof Error ? error.message : String(error), recoverability: 'retry' } }
    }
  }
  const port = {} as WorkbenchCommandPort
  for (const command of Object.keys(capabilityForCommand) as (keyof WorkbenchCommandPort)[]) {
    port[command] = ((...args: readonly unknown[]) => invoke(command, args)) as never
  }
  return port
}

/** Public adapter used by Suite implementations and isolated-surface bridges. */
export function createWorkbenchCommandPort(
  delegate: WorkbenchCommandFacade,
  capabilities: WorkbenchCapabilityReader,
): WorkbenchCommandPort {
  return createCommandPort(delegate, capabilities)
}

function createCapabilityReader(runtime: WorkbenchRuntime, declared: WorkbenchCapabilitySnapshot | undefined): WorkbenchCapabilityReader {
  const getSnapshot = (): WorkbenchCapabilitySnapshot => {
    const runtimeCapabilities = runtime.getSlice<{ canAttach?: boolean; promptImage?: boolean }>('capabilities')
    return Object.freeze({
      ...declared,
      attach: declared?.attach ?? runtimeCapabilities.canAttach ?? false,
    })
  }
  return {
    getSnapshot,
    has: capability => getSnapshot()[capability] === true,
    subscribe: listener => runtime.subscribe(listener),
  }
}

function createDiagnosticPort(input: WorkbenchHostPortInput): RendererDiagnosticPort {
  const history: RendererDiagnosticContext[] = []
  const listeners = new Set<() => void>()
  return {
    report(diagnostic) {
      const binding = input.binding?.() ?? input
      const enriched = Object.freeze({ ...diagnostic, suiteId: diagnostic.suiteId ?? binding.suiteId ?? input.suiteId, sessionId: diagnostic.sessionId ?? binding.sessionId, sheetId: binding.sheetId, sessionOwnerKey: binding.sessionOwnerKey })
      history.push(enriched)
      if (history.length > 100) history.shift()
      if (typeof input.diagnostics === 'function') input.diagnostics(enriched)
      else input.diagnostics?.report(enriched)
      for (const listener of [...listeners]) listener()
    },
    getRecent: () => Object.freeze([...history]),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    destroy: () => { history.length = 0; listeners.clear() },
  }
}

export function createWorkbenchHostPort(input: WorkbenchHostPortInput): WorkbenchHostPort {
  const capabilities = createCapabilityReader(input.runtime, input.capabilities)
  const namespace = () => {
    const binding = input.binding?.() ?? input
    return `${binding.suiteId ?? input.suiteId}\u0000${binding.sheetId}\u0000${binding.sessionOwnerKey ?? 'none'}`
  }
  return Object.freeze({
    document: createDocumentReader(input.runtime),
    appearance: createAppearanceReader(input),
    sessionUi: createSessionUiPort(input.sessionUi, namespace),
    commands: createCommandPort(input.commands, capabilities),
    capabilities,
    diagnostics: createDiagnosticPort(input),
  })
}

export type WorkbenchDocumentReaderValue = WorkbenchDocument | undefined
export type WorkbenchDocumentMessage = WorkbenchMessage
export type WorkbenchDocumentActivity = WorkbenchActivityNode
export type WorkbenchDocumentInteraction = WorkbenchInteraction
export type WorkbenchDocumentTimeline = WorkbenchTimelineEntry
