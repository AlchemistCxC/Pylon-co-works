import type { RendererActivationSnapshot, RendererSuiteContribution } from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import type { WorkbenchHostPort, WorkbenchMountInput, WorkbenchRendererInstance, PreparedWorkbenchRenderer } from '../../renderers/solid-workbench/workbenchContracts.ts'
import { createRendererSuiteCommandGate } from './rendererSuiteCommandGate.ts'
import { createRendererSuiteHostState, type RendererSuiteHostState } from './rendererSuiteHostState.ts'

export interface RendererSuiteHostOptions {
  readonly container: HTMLElement
  readonly hostPort: WorkbenchHostPort
  readonly input: WorkbenchMountInput
  readonly readyTimeoutMs?: number
}

export interface RendererSuiteHostListener {
  (state: RendererSuiteHostState): void
}

interface ActiveInstance {
  activation: RendererActivationSnapshot
  instance: WorkbenchRendererInstance
  gate: ReturnType<typeof createRendererSuiteCommandGate>
  staging: HTMLElement
}

export class RendererSuiteHost {
  private state: RendererSuiteHostState = createRendererSuiteHostState()
  private active: ActiveInstance | undefined
  private requestId = 0
  private destroyed = false
  private readonly listeners = new Set<RendererSuiteHostListener>()
  private readonly pending = new Set<Promise<void>>()
  private readonly readyCancellers = new Set<() => void>()
  private currentInput: WorkbenchMountInput

  constructor(private readonly options: RendererSuiteHostOptions) {
    this.currentInput = options.input
  }

  getState(): RendererSuiteHostState { return this.state }

  subscribe(listener: RendererSuiteHostListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async mount(activation: RendererActivationSnapshot): Promise<void> {
    await this.activate(activation, false)
  }

  switchTo(activation: RendererActivationSnapshot): Promise<void> {
    const work = this.activate(activation, true)
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work))
    return work
  }

  update(input: WorkbenchMountInput): void {
    if (this.destroyed) return
    this.currentInput = input
    try { this.active?.instance.update(input) } catch (error) {
      this.options.hostPort.diagnostics.report({ code: 'renderer.suite.update.failed', message: error instanceof Error ? error.message : String(error), phase: 'update', recoverability: 'fallback', suiteId: this.active?.activation.suite.value.id, documentRevision: this.options.hostPort.document.getSnapshot()?.revision })
    }
  }

  pause(): void {
    try { this.active?.instance.pause() } catch (error) {
      this.options.hostPort.diagnostics.report({ code: 'renderer.suite.pause.failed', message: error instanceof Error ? error.message : String(error), phase: 'update', recoverability: 'fallback', suiteId: this.active?.activation.suite.value.id })
    }
  }
  resume(): void {
    try { this.active?.instance.resume() } catch (error) {
      this.options.hostPort.diagnostics.report({ code: 'renderer.suite.resume.failed', message: error instanceof Error ? error.message : String(error), phase: 'update', recoverability: 'fallback', suiteId: this.active?.activation.suite.value.id })
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.requestId += 1
    for (const cancel of [...this.readyCancellers]) cancel()
    await Promise.allSettled([...this.pending])
    if (this.active) await this.destroyInstance(this.active)
    this.active = undefined
    this.options.container.replaceChildren()
    this.publish(createRendererSuiteHostState('destroyed'))
    this.listeners.clear()
  }

  private async activate(activation: RendererActivationSnapshot, switching: boolean): Promise<void> {
    if (this.destroyed) return
    const request = ++this.requestId
    for (const cancel of [...this.readyCancellers]) cancel()
    const old = this.active
    this.publish(createRendererSuiteHostState(switching || old ? 'switching' : 'preparing', {
      suiteId: activation.suite.value.id,
      previousSuiteId: old?.activation.suite.value.id,
      registryRevision: activation.revision,
      documentRevision: this.options.hostPort.document.getSnapshot()?.revision,
    }))
    const staging = this.options.container.ownerDocument.createElement('div')
    staging.dataset.rendererSuiteStaging = activation.suite.value.id
    staging.style.display = 'none'
    this.options.container.append(staging)
    let prepared: PreparedWorkbenchRenderer | undefined
    let instance: WorkbenchRendererInstance | undefined
    let failurePhase: 'prepare' | 'mount' = 'prepare'
    const gate = createRendererSuiteCommandGate()
    try {
      const candidateHost = Object.freeze({ ...this.options.hostPort, commands: gate.bind(this.options.hostPort.commands) })
      prepared = await this.prepare(activation.suite.value, activation.suite.value.factory, candidateHost)
      if (request !== this.requestId || this.destroyed) throw new StaleSuiteRequest()
      this.publish(createRendererSuiteHostState('mounting-candidate', { suiteId: activation.suite.value.id, previousSuiteId: old?.activation.suite.value.id, registryRevision: activation.revision, documentRevision: this.options.hostPort.document.getSnapshot()?.revision }))
      failurePhase = 'mount'
      instance = await prepared.mount(staging, this.currentInput, candidateHost)
      await this.waitReady(instance, this.options.readyTimeoutMs ?? 10_000)
      if (request !== this.requestId || this.destroyed) throw new StaleSuiteRequest()
      gate.activate()
      const previous = this.active
      this.options.container.replaceChildren(...Array.from(staging.childNodes))
      staging.remove()
      this.active = { activation, instance, gate, staging }
      this.publish(createRendererSuiteHostState('active', { suiteId: activation.suite.value.id, previousSuiteId: previous?.activation.suite.value.id, registryRevision: activation.revision, documentRevision: this.options.hostPort.document.getSnapshot()?.revision }))
      if (previous) {
        try { previous.instance.pause() } catch (error) {
          this.options.hostPort.diagnostics.report({ code: 'renderer.suite.pause.failed', message: error instanceof Error ? error.message : String(error), phase: 'switch', recoverability: 'none', suiteId: previous.activation.suite.value.id })
        }
        await this.destroyInstance(previous)
      }
    } catch (error) {
      gate.deactivate()
      if (instance) await this.safeDestroy(instance)
      staging.remove()
      if (error instanceof StaleSuiteRequest) return
      this.publish(createRendererSuiteHostState(old ? 'active' : 'degraded', { suiteId: old?.activation.suite.value.id, previousSuiteId: activation.suite.value.id, registryRevision: activation.revision, documentRevision: this.options.hostPort.document.getSnapshot()?.revision, error }))
      this.options.hostPort.diagnostics.report({ code: 'renderer.suite.switch.failed', message: error instanceof Error ? error.message : String(error), phase: failurePhase, recoverability: old ? 'fallback' : 'retry', suiteId: activation.suite.value.id, oldSuiteId: old?.activation.suite.value.id, newSuiteId: activation.suite.value.id, registryRevision: activation.revision, documentRevision: this.options.hostPort.document.getSnapshot()?.revision })
    }
  }

  private async prepare(suite: RendererSuiteContribution, factory: RendererSuiteContribution['factory'], host: WorkbenchHostPort): Promise<PreparedWorkbenchRenderer> {
    if (typeof factory === 'function') throw new Error(`Renderer Suite ${suite.id} factory 未实现 prepare`)
    return factory.prepare({ suiteId: suite.id, host })
  }

  private waitReady(instance: WorkbenchRendererInstance, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let unsubscribe = () => {}
      let unsubscribeError = () => {}
      const timer = setTimeout(() => fail(new Error('Renderer Suite ready 超时')), Math.max(1, timeoutMs))
      const cancel = () => fail(new StaleSuiteRequest())
      const cleanup = () => { this.readyCancellers.delete(cancel); clearTimeout(timer); unsubscribe(); unsubscribeError() }
      const finish = () => { if (!settled) { settled = true; cleanup(); resolve() } }
      const fail = (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error) } }
      this.readyCancellers.add(cancel)
      unsubscribe = instance.on('ready', finish)
      if (settled) unsubscribe()
      unsubscribeError = instance.on('error', fail)
      if (settled) unsubscribeError()
    })
  }

  private async destroyInstance(active: ActiveInstance): Promise<void> {
    active.gate.deactivate()
    try { await active.instance.destroy() } catch (error) {
      this.options.hostPort.diagnostics.report({
        code: 'renderer.suite.destroy.failed', message: error instanceof Error ? error.message : String(error), phase: 'destroy', recoverability: 'none',
        suiteId: active.activation.suite.value.id, registryRevision: active.activation.revision,
        documentRevision: this.options.hostPort.document.getSnapshot()?.revision,
      })
    }
    active.staging.remove()
  }

  private async safeDestroy(instance: WorkbenchRendererInstance): Promise<void> {
    try { await instance.destroy() } catch { /* candidate never became active */ }
  }

  private publish(next: RendererSuiteHostState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener(next)
  }
}

class StaleSuiteRequest extends Error {
  constructor() { super('stale renderer suite request') }
}
