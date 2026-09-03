import type { AppearanceCommand, WorkbenchAppearanceSnapshot, WorkbenchAppearanceStore } from '../../domains/workbench/appearance.ts'
import type { SessionUiKey, SessionUiScope, SessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchCommandFacade, SendCommand, SendResult, CancelResult, WorkbenchAttachment, SessionCreateInput, SessionCreateResult, ExportSessionInput, CommandResult, WorkbenchSessionCreationReader } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchDocument, WorkbenchMessage, WorkbenchActivityNode, WorkbenchInteraction, WorkbenchTimelineEntry } from '../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchRuntime, WorkbenchRuntimeSlice, WorkbenchRuntimeSnapshot } from '../../domains/workbench/workbenchRuntime.ts'
import type { RenderAppearanceSnapshot } from '../../contracts/messageRenderer.ts'
import type { GenerationActivitySnapshot } from '../../domains/workbench/generationFooterContracts.ts'
import type { InputPredictionProvider } from './input/inputPredictionProvider.ts'
import { reportRuntimeDiagnostic, reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'

export type WorkbenchDocumentSlice = 'document' | 'timeline' | 'messages' | 'activities' | 'interactions' | 'extensions' | 'session' | 'usage' | 'config' | 'commands' | 'assist' | 'diagnostics'

export interface WorkbenchDocumentReader {
  getSnapshot(): WorkbenchDocument | undefined
  subscribe(listener: () => void): () => void
  getSlice<T = unknown>(slice: WorkbenchDocumentSlice): T
  subscribeSlice(slice: WorkbenchDocumentSlice, listener: () => void): () => void
}

export type WorkbenchGenerationSnapshot = Readonly<Pick<WorkbenchRuntimeSnapshot,
  'generating' | 'generationStart' | 'lastTokenAt' | 'generationPhase' | 'thinkingStart' | 'tokenCount' | 'summary'> & {
  generationActivity?: GenerationActivitySnapshot
}>

/** Session-scoped ephemeral state that cannot be reconstructed from persisted transcript rows. */
export interface WorkbenchGenerationReader {
  getSnapshot(): WorkbenchGenerationSnapshot
  subscribe(listener: () => void): () => void
}

export interface ResolvedAppearanceReader {
  getSnapshot(): WorkbenchAppearanceSnapshot
  subscribe(listener: () => void): () => void
  /** Host-gated mutation seam; absent/false means the Suite is read-only. */
  dispatch?(command: AppearanceCommand): boolean
  resolve?(request: { readonly kind: string; readonly suiteId: string; readonly slotId: string }): RenderAppearanceSnapshot
}

export interface SessionUiPort {
  get<T>(key: SessionUiKey, fallback: T): T
  set<T>(key: SessionUiKey, value: T): void
  update<T>(key: SessionUiKey, fallback: T, updater: (previous: T) => T): T
  subscribe(key: SessionUiKey, listener: () => void): () => void
  capture(): SessionUiScope
  clear(): void
}

export type WorkbenchCapability = 'prompt' | 'cancel' | 'attach' | 'model' | 'mode'
  | 'sessionCreate' | 'compact' | 'sessionExport' | 'sessionClear'
  | 'sessionConfig'
  | 'toolAction' | 'interactionResponse' | 'resourceOpen' | 'resourceReveal'
  | 'clipboardWrite' | 'retry' | 'recovery' | 'appearanceEdit'
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
  createSession(input?: SessionCreateInput): Promise<WorkbenchCommandResult<SessionCreateResult>>
  compact(sessionId: string): Promise<WorkbenchCommandResult<CommandResult>>
  exportSession(sessionId: string, input: ExportSessionInput): Promise<WorkbenchCommandResult<CommandResult>>
  clearSession(sessionId: string): Promise<WorkbenchCommandResult<CommandResult>>
  setConfigOption(sessionId: string, key: string, value: unknown,
    options?: { expectedValue?: unknown; expectedVersion?: number }): Promise<WorkbenchCommandResult<CommandResult>>
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
  readonly generation: WorkbenchGenerationReader
  readonly appearance: ResolvedAppearanceReader
  readonly sessionUi: SessionUiPort
  readonly commands: WorkbenchCommandPort
  /** Display-only empty-state creation lifecycle; never persisted as a fact. */
  readonly sessionCreation?: WorkbenchSessionCreationReader
  readonly capabilities: WorkbenchCapabilityReader
  readonly diagnostics: RendererDiagnosticPort
  /** Optional host-owned local/remote provider for input prediction. */
  readonly predictionProvider?: InputPredictionProvider
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
  readonly predictionProvider?: InputPredictionProvider
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

function createGenerationReader(runtime: WorkbenchRuntime): WorkbenchGenerationReader {
  const getSnapshot = (): WorkbenchGenerationSnapshot => {
    const snapshot = runtime.getSnapshot()
    return Object.freeze({
      generating: snapshot.generating,
      generationStart: snapshot.generationStart,
      lastTokenAt: snapshot.lastTokenAt,
      generationPhase: snapshot.generationPhase,
      generationActivity: snapshot.generationActivity,
      thinkingStart: snapshot.thinkingStart,
      tokenCount: snapshot.tokenCount,
      summary: snapshot.summary,
    })
  }
  return { getSnapshot, subscribe: listener => runtime.subscribe(listener) }
}

function createAppearanceReader(input: WorkbenchHostPortInput, capabilities: WorkbenchCapabilityReader): ResolvedAppearanceReader {
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
    dispatch(command) {
      if (!capabilities.has('appearanceEdit')) return false
      input.appearance.dispatch(command)
      return true
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
    capture: () => store.capture(namespace()),
    clear: () => store.clear(namespace()),
  }
}

const capabilityForCommand: Readonly<Record<keyof WorkbenchCommandPort, WorkbenchCapability>> = {
  prompt: 'prompt', send: 'prompt', cancel: 'cancel', attach: 'attach', setModel: 'model', setMode: 'mode',
  createSession: 'sessionCreate', compact: 'compact', exportSession: 'sessionExport', clearSession: 'sessionClear', toolAction: 'toolAction',
  setConfigOption: 'sessionConfig',
  respondInteraction: 'interactionResponse', openResource: 'resourceOpen', revealResource: 'resourceReveal', copy: 'clipboardWrite', retry: 'retry', recover: 'recovery',
}

type CommandBindingSnapshot = {
  readonly suiteId?: string
  readonly sheetId: string
  readonly sessionOwnerKey: string | null
  readonly sessionId: string | null
}

const commandAction: Readonly<Record<keyof WorkbenchCommandPort, string>> = {
  prompt: '发送消息', send: '发送消息', cancel: '取消生成', attach: '添加附件',
  setModel: '切换模型', setMode: '切换权限模式', createSession: '创建会话', compact: '压缩会话',
  exportSession: '导出会话', clearSession: '清空会话', setConfigOption: '更新会话配置',
  toolAction: '执行工具操作', respondInteraction: '处理交互请求', openResource: '打开资源',
  revealResource: '显示资源', copy: '复制内容', retry: '重试消息', recover: '恢复会话',
}

const commandRecoveryKind: Readonly<Partial<Record<keyof WorkbenchCommandPort, 'retry' | 'log'>>> = {
  prompt: 'retry', send: 'retry', cancel: 'retry', setModel: 'retry', setMode: 'retry',
  createSession: 'retry', compact: 'retry', exportSession: 'retry', clearSession: 'retry',
  setConfigOption: 'retry', toolAction: 'retry', respondInteraction: 'retry',
  openResource: 'retry', revealResource: 'retry', copy: 'retry', retry: 'retry', recover: 'retry',
  attach: 'log',
}

function commandBinding(input: WorkbenchHostPortInput): CommandBindingSnapshot {
  const binding = input.binding?.() ?? input
  return {
    suiteId: binding.suiteId ?? input.suiteId,
    sheetId: binding.sheetId,
    sessionOwnerKey: binding.sessionOwnerKey,
    sessionId: binding.sessionId,
  }
}

function sameCommandBinding(left: CommandBindingSnapshot, right: CommandBindingSnapshot): boolean {
  return left.suiteId === right.suiteId
    && left.sheetId === right.sheetId
    && left.sessionOwnerKey === right.sessionOwnerKey
    && left.sessionId === right.sessionId
}

function targetCommandBinding(
  binding: CommandBindingSnapshot,
  command: keyof WorkbenchCommandPort,
  args: readonly unknown[],
): CommandBindingSnapshot {
  // Every session command carries its target Session.id as the first argument.
  // Prefer that explicit identity over a potentially lagging mount binding so
  // a command issued during a switch is attributed to the session it actually
  // addressed (and never to whichever session happens to be visible later).
  const target = typeof args[0] === 'string' && args[0].trim() && command !== 'createSession'
    ? args[0].trim()
    : binding.sessionId
  return target === binding.sessionId ? binding : { ...binding, sessionId: target }
}

function commandScope(binding: CommandBindingSnapshot, command: keyof WorkbenchCommandPort) {
  return binding.sessionId
    ? { kind: 'session' as const, id: binding.sessionId }
    : { kind: 'operation' as const, id: `${binding.sheetId}:${binding.suiteId ?? 'unknown'}:${command}` }
}

function commandErrorPrefix(binding: CommandBindingSnapshot, command: keyof WorkbenchCommandPort): string {
  const scope = commandScope(binding, command)
  return `workbench-command:${scope.kind}:${scope.id}:${command}:`
}

function isPresentableCommandError(error: WorkbenchCommandError): boolean {
  // A missing capability is an intentional renderer contract outcome (for
  // example a read-only third-party Suite), not an operational failure. It
  // remains available through Renderer diagnostics and the local field state.
  return error.code !== 'command_capability_denied'
}

function reportCommandFailure(
  binding: CommandBindingSnapshot,
  command: keyof WorkbenchCommandPort,
  error: WorkbenchCommandError,
  stale = false,
): void {
  if (!isPresentableCommandError(error)) return
  const scope = commandScope(binding, command)
  const report = stale ? reportRuntimeDiagnostic : reportRuntimeError
  report(commandAction[command], { code: error.code, message: error.message }, undefined, {
    key: `${commandErrorPrefix(binding, command)}${error.code}`,
    scope,
    source: 'workbench.command',
    recovery: { kind: 'open-runtime-log', sessionId: binding.sessionId ?? undefined },
    metadata: {
      command,
      suiteId: binding.suiteId,
      sheetId: binding.sheetId,
      sessionOwnerKey: binding.sessionOwnerKey,
      recoverability: error.recoverability,
      recoveryKind: commandRecoveryKind[command] ?? 'log',
      staleBinding: stale,
    },
  })
}

function resolveCommandFailures(binding: CommandBindingSnapshot, command: keyof WorkbenchCommandPort): void {
  const prefix = commandErrorPrefix(binding, command)
  resolveRuntimeErrors(entry => entry.source === 'workbench.command' && entry.key.startsWith(prefix))
}

function createCommandPort(
  delegate: WorkbenchCommandFacade,
  capabilities: WorkbenchCapabilityReader,
  readBinding: () => CommandBindingSnapshot,
): WorkbenchCommandPort {
  const invoke = async <K extends keyof WorkbenchCommandPort>(command: K, args: readonly unknown[]): Promise<WorkbenchCommandResult<unknown>> => {
    // Capture the binding before awaiting the delegate. A session switch while
    // a provider call is in flight must not resolve or re-key the new session's
    // notification when the old call eventually settles.
    const binding = targetCommandBinding(readBinding(), command, args)
    const mountBinding = readBinding()
    const capability = capabilityForCommand[command]
    if (!capabilities.has(capability)) return { ok: false, error: { code: 'command_capability_denied', message: `命令能力未授权：${capability}`, recoverability: 'none', capability } }
    try {
      const method = delegate[command] as (...values: readonly unknown[]) => Promise<unknown>
      const result = await method(...args)
      const stale = !sameCommandBinding(mountBinding, readBinding())
      if (result && typeof result === 'object' && 'status' in result && result.status === 'rejected') {
        const message = 'error' in result && typeof (result as { error?: unknown }).error === 'string'
          && (result as { error: string }).error.trim().length > 0
          ? (result as { error: string }).error
          : '命令被运行时拒绝'
        const error = { code: 'command_rejected', message, recoverability: message === '命令被运行时拒绝' ? 'none' as const : 'retry' as const }
        reportCommandFailure(binding, command, error, stale)
        return { ok: false, error }
      }
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        const error = 'error' in result ? (result as { error?: unknown }).error : undefined
        const normalized = { code: 'command_rejected', message: typeof error === 'string' ? error : '命令被运行时拒绝', recoverability: 'retry' as const }
        reportCommandFailure(binding, command, normalized, stale)
        return { ok: false, error: normalized }
      }
      if (!stale) resolveCommandFailures(binding, command)
      return { ok: true, value: result }
    } catch (error) {
      const stale = !sameCommandBinding(mountBinding, readBinding())
      const normalized = { code: 'command_failed', message: error instanceof Error ? error.message : String(error), recoverability: 'retry' as const }
      reportCommandFailure(binding, command, normalized, stale)
      return { ok: false, error: normalized }
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
  // This public helper has no host binding metadata. Keep the old behavior
  // for callers that construct a command port in isolation; the application
  // HostPort path below supplies the scoped error context.
  return createCommandPort(delegate, capabilities, () => ({
    suiteId: 'unknown', sheetId: 'unknown', sessionOwnerKey: null, sessionId: null,
  }))
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
    generation: createGenerationReader(input.runtime),
    appearance: createAppearanceReader(input, capabilities),
    sessionUi: createSessionUiPort(input.sessionUi, namespace),
    commands: createCommandPort(input.commands, capabilities, () => commandBinding(input)),
    sessionCreation: input.commands.sessionCreation,
    capabilities,
    diagnostics: createDiagnosticPort(input),
    predictionProvider: input.predictionProvider,
  })
}

export type WorkbenchDocumentReaderValue = WorkbenchDocument | undefined
export type WorkbenchDocumentMessage = WorkbenchMessage
export type WorkbenchDocumentActivity = WorkbenchActivityNode
export type WorkbenchDocumentInteraction = WorkbenchInteraction
export type WorkbenchDocumentTimeline = WorkbenchTimelineEntry
