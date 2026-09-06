import type { RegistryEntry } from '../registry/types.ts'
import { HookRegistry, type RegisteredHookDefinition } from './hookRegistry.ts'
import type {
  HookCircuitDescriptor,
  HookInvocationResult,
  HookName,
  HookTraceEntry,
} from './hookTypes.ts'

interface CircuitState {
  failures: number
  openedAt: number
}

interface HookLease {
  readonly controller: AbortController
  readonly promise: Promise<unknown>
}

export interface HookRuntimeOptions {
  failureLimit?: number
  cooldownMs?: number
  traceLimit?: number
  onDisablePlugin?: (pluginId: string) => void | Promise<void>
}

export class HookRuntime {
  readonly registry: HookRegistry
  private readonly circuits = new Map<string, CircuitState>()
  private readonly disabledHandlers = new Set<string>()
  private readonly activeLeases = new Map<string, Set<HookLease>>()
  private readonly traceListeners = new Set<() => void>()
  private readonly failureLimit: number
  private readonly cooldownMs: number
  private readonly traceLimit: number
  private readonly onDisablePlugin?: HookRuntimeOptions['onDisablePlugin']
  private traces: HookTraceEntry[] = []
  private invocationSequence = 0
  private traceRevision = 0
  private currentTraceSnapshot: Readonly<{ revision: number; entries: readonly HookTraceEntry[] }> = Object.freeze({
    revision: 0,
    entries: Object.freeze([]),
  })

  constructor(registry = new HookRegistry(), options: HookRuntimeOptions = {}) {
    this.registry = registry
    this.failureLimit = options.failureLimit ?? 3
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.traceLimit = options.traceLimit ?? 200
    this.onDisablePlugin = options.onDisablePlugin
  }

  hasEnabledHooks(hookName: HookName, enabledPluginIds?: readonly string[]): boolean {
    return this.resolve(hookName, enabledPluginIds).length > 0
  }

  /**
   * P55-D1：可选外部取消信号（kernel hook dispatcher 桥超时/取消联动）。
   * 传入时每个 handler 的内部 AbortController 联动外部信号（abort 传播）；
   * 不传时行为与既往逐字节等价（不注册任何监听）。
   */
  async invoke<TEvent>(
    hookName: HookName,
    event: TEvent,
    enabledPluginIds?: readonly string[],
    externalSignal?: AbortSignal,
  ): Promise<HookInvocationResult<TEvent>> {
    const entries = this.resolve(hookName, enabledPluginIds)
    if (entries.length === 0) return { action: 'continue', event, executed: 0, skipped: 0 }

    const invocationId = `${hookName}#${++this.invocationSequence}`
    let effectiveEvent = event
    let executed = 0
    let skipped = 0

    for (const entry of entries) {
      const definition = entry.value
      const handlerKey = entry.contributionId
      if (this.disabledHandlers.has(handlerKey) || this.circuitOpen(entry.ownerPluginId, Date.now())) {
        skipped += 1
        this.pushTrace({
          invocationId,
          hookName,
          pluginId: entry.ownerPluginId,
          runtimeInstanceId: entry.ownerRuntimeInstanceId,
          handlerId: definition.id,
          startedAt: Date.now(),
          durationMs: 0,
          outcome: 'skipped',
        })
        continue
      }

      const startedAt = Date.now()
      const controller = new AbortController()
      // P55-D1：外部信号联动——监听器随本 handler 租约结束移除（防泄漏）；
      // already-aborted 信号在注册后立即传播一次。
      let onExternalAbort: (() => void) | undefined
      if (externalSignal) {
        onExternalAbort = () => controller.abort(externalSignal.reason)
        externalSignal.addEventListener('abort', onExternalAbort, { once: true })
        if (externalSignal.aborted) controller.abort(externalSignal.reason)
      }
      const detachExternalSignal = () => {
        if (onExternalAbort && externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort)
          onExternalAbort = undefined
        }
      }
      const promise = Promise.resolve().then(() => definition.handler({
        invocationId,
        hookName,
        event: effectiveEvent,
        signal: controller.signal,
      }))
      const lease = { controller, promise }
      this.addLease(entry.ownerRuntimeInstanceId, lease)

      if (definition.execution === 'background') {
        executed += 1
        void promise.then(result => {
          this.circuits.delete(entry.ownerPluginId)
          this.pushTrace({
            invocationId,
            hookName,
            pluginId: entry.ownerPluginId,
            runtimeInstanceId: entry.ownerRuntimeInstanceId,
            handlerId: definition.id,
            startedAt,
            durationMs: Date.now() - startedAt,
            outcome: result && result.action === 'respond' ? 'responded'
              : result && result.action === 'cancel' ? 'cancelled'
                : result && result.action === 'continue' && result.event !== undefined ? 'transformed' : 'continued',
          })
        }).catch(error => this.handleFailure(entry, invocationId, startedAt, error, false))
          .finally(() => {
            detachExternalSignal()
            this.removeLease(entry.ownerRuntimeInstanceId, lease)
          })
        continue
      }

      const timeoutMs = definition.timeoutMs ?? 3000
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<symbol>(resolve => {
          timeoutHandle = setTimeout(() => {
            controller.abort(`Hook timeout: ${definition.id}`)
            resolve(TIMEOUT)
          }, timeoutMs)
        })
        const raced = await Promise.race([promise, timeout])
        if (raced === TIMEOUT) {
          skipped += 1
          const failureResult = await this.handleFailure(entry, invocationId, startedAt, new Error('Hook timed out'), true)
          if (failureResult) return { ...failureResult, event: effectiveEvent, executed, skipped }
          continue
        }
        const result = raced as Awaited<typeof promise>
        this.circuits.delete(entry.ownerPluginId)
        executed += 1
        if (!result) {
          this.pushSuccessTrace(entry, invocationId, startedAt, 'continued')
          continue
        }
        // Notification hooks are observe-only: action-bearing results are ignored.
        if (definition.mode === 'notification' && result.action !== 'continue') {
          this.pushSuccessTrace(entry, invocationId, startedAt, 'continued')
          continue
        }
        if (result.action === 'cancel') {
          this.pushSuccessTrace(entry, invocationId, startedAt, 'cancelled')
          return { action: 'cancel', event: effectiveEvent, reason: result.reason, executed, skipped }
        }
        if (result.action === 'respond') {
          this.pushSuccessTrace(entry, invocationId, startedAt, 'responded')
          return { action: 'respond', event: effectiveEvent, output: result.output, executed, skipped }
        }
        if (result.action === 'send') {
          this.pushSuccessTrace(entry, invocationId, startedAt, 'responded')
          return { action: 'send', event: effectiveEvent, message: result.message, executed, skipped }
        }
        if (result.event !== undefined) {
          effectiveEvent = result.event as TEvent
          this.pushSuccessTrace(entry, invocationId, startedAt, 'transformed')
        } else {
          this.pushSuccessTrace(entry, invocationId, startedAt, 'continued')
        }
      } catch (error) {
        const failureResult = await this.handleFailure(entry, invocationId, startedAt, error, false)
        if (failureResult) return { ...failureResult, event: effectiveEvent, executed, skipped }
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        detachExternalSignal()
        this.removeLease(entry.ownerRuntimeInstanceId, lease)
      }
    }

    return { action: 'continue', event: effectiveEvent, executed, skipped }
  }

  async drain(runtimeInstanceId: string, timeoutMs = 10_000): Promise<void> {
    const leases = this.activeLeases.get(runtimeInstanceId)
    if (!leases || leases.size === 0) return
    const all = Promise.allSettled([...leases].map(lease => lease.promise)).then(() => undefined)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>(resolve => {
      timeoutHandle = setTimeout(() => {
        for (const lease of leases) lease.controller.abort(`Hook drain timeout: ${runtimeInstanceId}`)
        resolve()
      }, timeoutMs)
    })
    await Promise.race([all, timeout])
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }

  traceSnapshot() {
    return this.currentTraceSnapshot
  }

  subscribeTrace(listener: () => void): () => void {
    this.traceListeners.add(listener)
    return () => this.traceListeners.delete(listener)
  }

  circuitsSnapshot(): HookCircuitDescriptor[] {
    return [...this.circuits.entries()].map(([pluginId, circuit]) => ({
      pluginId,
      failures: circuit.failures,
      openedAt: circuit.openedAt > 0 ? circuit.openedAt : null,
    }))
  }

  reset(): void {
    this.circuits.clear()
    this.disabledHandlers.clear()
  }

  private resolve(hookName: HookName, enabledPluginIds?: readonly string[]) {
    return this.registry.resolve(hookName, enabledPluginIds).filter(entry => !this.disabledHandlers.has(entry.contributionId))
  }

  private circuitOpen(pluginId: string, now: number): boolean {
    const circuit = this.circuits.get(pluginId)
    if (!circuit) return false
    if (circuit.openedAt > 0 && now - circuit.openedAt >= this.cooldownMs) {
      this.circuits.delete(pluginId)
      return false
    }
    return circuit.failures >= this.failureLimit
  }

  private recordFailure(pluginId: string, now: number): void {
    const circuit = this.circuits.get(pluginId) ?? { failures: 0, openedAt: 0 }
    circuit.failures += 1
    if (circuit.failures >= this.failureLimit && circuit.openedAt === 0) circuit.openedAt = now
    this.circuits.set(pluginId, circuit)
  }

  private async handleFailure(
    entry: RegistryEntry<RegisteredHookDefinition>,
    invocationId: string,
    startedAt: number,
    error: unknown,
    timedOut: boolean,
  ): Promise<{ action: 'cancel'; reason: string } | undefined> {
    this.recordFailure(entry.ownerPluginId, Date.now())
    const policy = entry.value.failurePolicy ?? 'continue'
    this.pushTrace({
      invocationId,
      hookName: entry.value.hookName,
      pluginId: entry.ownerPluginId,
      runtimeInstanceId: entry.ownerRuntimeInstanceId,
      handlerId: entry.value.id,
      startedAt,
      durationMs: Date.now() - startedAt,
      outcome: timedOut ? 'timed-out' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    if (policy === 'disable-hook') this.disabledHandlers.add(entry.contributionId)
    if (policy === 'disable-plugin') {
      this.disabledHandlers.add(entry.contributionId)
      try {
        await this.onDisablePlugin?.(entry.ownerPluginId)
      } catch (disableError) {
        this.pushTrace({
          invocationId,
          hookName: entry.value.hookName,
          pluginId: entry.ownerPluginId,
          runtimeInstanceId: entry.ownerRuntimeInstanceId,
          handlerId: entry.value.id,
          startedAt,
          durationMs: Date.now() - startedAt,
          outcome: 'plugin-disable-failed',
          error: disableError instanceof Error ? disableError.message : String(disableError),
        })
      }
    }
    if (policy === 'abort') {
      return { action: 'cancel', reason: error instanceof Error ? error.message : String(error) }
    }
    return undefined
  }

  private pushSuccessTrace(
    entry: RegistryEntry<RegisteredHookDefinition>,
    invocationId: string,
    startedAt: number,
    outcome: HookTraceEntry['outcome'],
  ): void {
    this.pushTrace({
      invocationId,
      hookName: entry.value.hookName,
      pluginId: entry.ownerPluginId,
      runtimeInstanceId: entry.ownerRuntimeInstanceId,
      handlerId: entry.value.id,
      startedAt,
      durationMs: Date.now() - startedAt,
      outcome,
    })
  }

  private pushTrace(trace: HookTraceEntry): void {
    this.traces = [...this.traces.slice(-(this.traceLimit - 1)), trace]
    this.traceRevision += 1
    this.currentTraceSnapshot = Object.freeze({
      revision: this.traceRevision,
      entries: Object.freeze([...this.traces]),
    })
    for (const listener of [...this.traceListeners]) listener()
  }

  private addLease(runtimeInstanceId: string, lease: HookLease): void {
    const leases = this.activeLeases.get(runtimeInstanceId) ?? new Set<HookLease>()
    leases.add(lease)
    this.activeLeases.set(runtimeInstanceId, leases)
  }

  private removeLease(runtimeInstanceId: string, lease: HookLease): void {
    const leases = this.activeLeases.get(runtimeInstanceId)
    if (!leases) return
    leases.delete(lease)
    if (leases.size === 0) this.activeLeases.delete(runtimeInstanceId)
  }
}

const TIMEOUT = Symbol('hook-timeout')
