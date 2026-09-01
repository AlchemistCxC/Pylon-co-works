import type { Message } from '../../components/chat/messageTypes.ts'
import type { WorkbenchAppearanceStore } from '../../domains/workbench/appearance.ts'
import type { SessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import type { CancelResult, CommandResult, SendResult, WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchRuntime, WorkbenchRuntimeSnapshot, WorkbenchRuntimeSlice } from '../../domains/workbench/workbenchRuntime.ts'
import type {
  WorkbenchCommandError,
  WorkbenchCommandResult,
  WorkbenchHostPort,
} from './workbenchHostPort.ts'
import type { SolidWorkbenchServices } from './workbenchContracts.ts'
import { resolveDocumentOptionEntries } from './input/workbenchOptionCatalog.ts'

function optionIds(
  document: WorkbenchDocument | undefined,
  kind: 'model' | 'mode',
  current: string | undefined,
): readonly string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of resolveDocumentOptionEntries(document?.session.options, kind)) {
    const id = entry.id.trim()
    if (!id || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    ids.push(id)
  }
  const active = current?.trim() ?? ''
  if (active && !seen.has(active.toLowerCase())) ids.unshift(active)
  return Object.freeze(ids)
}

function documentMessages(document: WorkbenchDocument | undefined): readonly Message[] {
  return document?.messages.map(message => ({
    id: message.id, role: message.role, sender: message.source.provider,
    content: message.content, time: message.time, running: message.running,
  })) ?? []
}

function runtimeSnapshot(host: WorkbenchHostPort): WorkbenchRuntimeSnapshot {
  const document = host.document.getSnapshot()
  const messages = documentMessages(document)
  const generation = host.generation.getSnapshot()
  const error = [...(document?.diagnostics ?? [])].reverse().find(item => item.level === 'error')?.message ?? null
  const activeModel = document?.session.model ?? ''
  const activeMode = document?.session.mode ?? ''
  return Object.freeze({
    revision: document?.revision ?? 0, sessionId: document?.sessionId || null,
    status: error ? 'degraded' : document ? 'ready' : 'idle', messages,
    streamingText: '', streamingThinking: '', generating: generation.generating,
    generationStart: generation.generationStart, lastTokenAt: generation.lastTokenAt,
    tokenCount: generation.tokenCount, summary: generation.summary,
    generationPhase: generation.generationPhase,
    generationActivity: generation.generationActivity,
    thinkingStart: generation.thinkingStart, tasks: document?.plan.entries ?? Object.freeze([]),
    // Keep the host-port projection provider-neutral: ACP choices are carried
    // in the canonical session option surface, not in renderer-local stores.
    // A third-party Suite therefore sees the same model/mode catalogue as the
    // built-in Solid renderer even when its legacy runtime arrays are empty.
    availableModels: optionIds(document, 'model', activeModel), activeModel,
    availableModes: optionIds(document, 'mode', activeMode), activeMode,
    canAttach: host.capabilities.has('attach'), promptImage: false, error, document,
  })
}

function createRuntime(host: WorkbenchHostPort): WorkbenchRuntime {
  const slice = (name: WorkbenchRuntimeSlice): unknown => {
    if (name === 'streaming') return { text: '', thinking: '' }
    if (name === 'capabilities') return { canAttach: host.capabilities.has('attach'), promptImage: false }
    if (name === 'tasks') return host.document.getSnapshot()?.plan.entries ?? []
    return host.document.getSlice(name as never)
  }
  return {
    getSnapshot: () => runtimeSnapshot(host),
    subscribe: listener => {
      // A Suite may expose document and generation as separate readers. Queue
      // one notification per microtask so split updates converge to the latest
      // combined snapshot without duplicate renders when both readers share a
      // runtime implementation.
      let queued = false
      const notify = () => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          listener()
        })
      }
      const unsubscribeDocument = host.document.subscribe(notify)
      const unsubscribeGeneration = host.generation.subscribe(notify)
      return () => { unsubscribeDocument(); unsubscribeGeneration() }
    },
    getSlice: name => slice(name) as never,
    subscribeSlice: (name, listener) => name === 'capabilities'
      ? host.capabilities.subscribe(listener)
      : host.document.subscribeSlice(name as never, listener),
  }
}

function createAppearance(host: WorkbenchHostPort): WorkbenchAppearanceStore {
  return {
    getSnapshot: () => host.appearance.getSnapshot(),
    subscribe: listener => host.appearance.subscribe(listener),
    dispatch(command) {
      if (host.appearance.dispatch?.(command) === true) return
      host.diagnostics.report({
        code: 'renderer.appearance.command.denied', message: `Suite 无权修改宿主外观：${command.type}`,
        phase: 'action', recoverability: 'none',
      })
    },
    destroy() {},
  }
}

function createSessionUi(host: WorkbenchHostPort): SessionUiStore {
  return {
    get: (_namespace, key, fallback) => host.sessionUi.get(key, fallback),
    set: (_namespace, key, value) => host.sessionUi.set(key, value),
    update: (_namespace, key, fallback, updater) => host.sessionUi.update(key, fallback, updater),
    subscribe: (_namespace, key, listener) => host.sessionUi.subscribe(key, listener),
    capture: () => host.sessionUi.capture(),
    clear: () => host.sessionUi.clear(), clearAll: () => host.sessionUi.clear(), destroy() {},
  }
}

function reportCommandFailure(host: WorkbenchHostPort, command: keyof WorkbenchCommandFacade, error: WorkbenchCommandError): void {
  host.diagnostics.report({
    code: error.code, message: error.message, phase: 'action', recoverability: error.recoverability ?? 'none', command,
  })
}

function unwrap<T>(host: WorkbenchHostPort, command: keyof WorkbenchCommandFacade, result: WorkbenchCommandResult<T>): T {
  if (result.ok) return result.value
  reportCommandFailure(host, command, result.error)
  throw new Error(result.error.message)
}

function commandResult(host: WorkbenchHostPort, command: keyof WorkbenchCommandFacade, result: WorkbenchCommandResult<CommandResult>): CommandResult {
  if (result.ok) return result.value
  reportCommandFailure(host, command, result.error)
  return { ok: false, error: result.error.message }
}

function sendResult(host: WorkbenchHostPort, command: 'prompt' | 'send', result: WorkbenchCommandResult<SendResult>): SendResult {
  if (result.ok) return result.value
  reportCommandFailure(host, command, result.error)
  return { status: 'rejected', error: result.error.message }
}

function cancelResult(host: WorkbenchHostPort, result: WorkbenchCommandResult<CancelResult>): CancelResult {
  if (result.ok) return result.value
  reportCommandFailure(host, 'cancel', result.error)
  return { status: 'rejected', error: result.error.message }
}

function createCommands(host: WorkbenchHostPort): WorkbenchCommandFacade {
  return {
    prompt: async (id, command) => sendResult(host, 'prompt', await host.commands.prompt(id, command)),
    send: async (id, command) => sendResult(host, 'send', await host.commands.send(id, command)),
    cancel: async id => cancelResult(host, await host.commands.cancel(id)),
    attach: async id => unwrap(host, 'attach', await host.commands.attach(id)),
    setModel: async (id, value) => commandResult(host, 'setModel', await host.commands.setModel(id, value)),
    setMode: async (id, value) => commandResult(host, 'setMode', await host.commands.setMode(id, value)),
    createSession: async input => unwrap(host, 'createSession', await host.commands.createSession(input)),
    compact: async id => commandResult(host, 'compact', await host.commands.compact(id)),
    exportSession: async (id, input) => commandResult(host, 'exportSession', await host.commands.exportSession(id, input)),
    clearSession: async id => commandResult(host, 'clearSession', await host.commands.clearSession(id)),
    setConfigOption: async (id, key, value, options) => commandResult(host, 'setConfigOption', await host.commands.setConfigOption(id, key, value, options)),
    toolAction: async (id, callId, action, payload) => commandResult(host, 'toolAction', await host.commands.toolAction(id, callId, action, payload)),
    respondInteraction: async (id, interactionId, response, options) => commandResult(host, 'respondInteraction', await host.commands.respondInteraction(id, interactionId, response, options)),
    openResource: async (id, resource) => commandResult(host, 'openResource', await host.commands.openResource(id, resource)),
    revealResource: async (id, resource) => commandResult(host, 'revealResource', await host.commands.revealResource(id, resource)),
    copy: async (id, text) => commandResult(host, 'copy', await host.commands.copy(id, text)),
    retry: async (id, messageId) => commandResult(host, 'retry', await host.commands.retry(id, messageId)),
    recover: async (id, strategy) => commandResult(host, 'recover', await host.commands.recover(id, strategy)),
  }
}

export function createSolidWorkbenchServicesFromHostPort(host: WorkbenchHostPort): SolidWorkbenchServices {
  return Object.freeze({ runtime: createRuntime(host), appearance: createAppearance(host), sessionUi: createSessionUi(host), commands: createCommands(host), hostPort: host, predictionProvider: host.predictionProvider })
}
