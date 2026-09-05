import { createPackagePluginIdentity, createPluginIdentity, type PluginIdentity } from './pluginIdentity.ts'
import {
  activateBuiltinPlugin,
  deactivatePluginInstance,
  type BuiltinPluginActivate,
  type BuiltinPluginActivationContext,
  type PluginDeactivateResult,
  type PluginInstance,
} from './pluginInstance.ts'
import {
  createPluginActivationContext,
  type PluginActivationContextFactory,
} from './pluginActivationContext.ts'
import type { PluginHostServices } from './pluginHostServices.ts'
import type { PluginManagementApi } from './management/pluginManagementTypes.ts'
import {
  resolvePluginContracts,
  type PluginContract,
  type PluginContractDiagnostic,
} from './pluginContractResolver.ts'
import { PluginScope } from './pluginScope.ts'
import {
  PluginContributionTransaction,
  type HotSwapMode,
  type PluginUpdateResult,
} from './shadowUpdate.ts'
import type { PylonPluginCapability } from './packageManifest.ts'

export interface BuiltinPluginDefinition {
  id: string
  kind?: 'shell' | 'workspace' | 'feature' | 'hook' | 'renderer' | 'skin' | 'agent-adapter' | 'tool-provider' | 'service' | 'automation'
  firstParty?: boolean
  criticality?: 'kernel-required' | 'product-required' | 'optional'
  dependencies?: Readonly<Record<string, string>>
  optionalDependencies?: Readonly<Record<string, string>>
  conflicts?: readonly string[]
  activationEvents?: readonly string[]
  version?: string
  /** API 1.2：manifest 声明的宿主能力（封闭词表）；缺省 = 不声明。 */
  capabilities?: readonly PylonPluginCapability[]
  packageInstanceId?: string
  runtimeInstanceId?: string
  hotSwapMode?: HotSwapMode
  drainTimeoutMs?: number
  prepare?: (context: BuiltinPluginActivationContext) => unknown | Promise<unknown>
  activate: BuiltinPluginActivate
  suspend?: () => void | Promise<void>
  resume?: () => void | Promise<void>
  deactivate?: () => void | Promise<void>
}

export type BuiltinPluginDefinitionFactory = (
  context: BuiltinPluginActivationContext,
) => BuiltinPluginDefinition

export interface PluginSwitchDescriptor extends PluginUpdateResult {
  readonly committedAt: number
}

export interface PluginRuntimeSnapshot {
  readonly revision: number
  readonly active: readonly PluginIdentity[]
  readonly instances: readonly PluginRuntimeInstanceSnapshot[]
  readonly switches: readonly PluginSwitchDescriptor[]
}

export interface PluginRuntimeInstanceSnapshot {
  readonly identity: PluginIdentity
  readonly status: PluginInstance['status']
  readonly cleanup?: PluginDeactivateResult
}

export interface PluginRuntimeOptions {
  host: PluginHostServices
  requestSoftRemount?: () => void | Promise<void>
  /** API 1.2 capability 装配器：声明 ∧ 授权时返回 PluginManagementApi（C3 门控）。 */
  createManagementApi?: (definition: BuiltinPluginDefinition, scope: PluginScope) => PluginManagementApi | undefined
}

export interface PluginUpdateOptions {
  identity?: PluginIdentity
  commitActivePointer?: () => void | Promise<void>
  requestSoftRemount?: () => void | Promise<void>
}

export class PluginRestartRequiredError extends Error {
  readonly pluginId: string
  readonly declaredMode: HotSwapMode = 'restart-required'
  readonly adoptedMode: HotSwapMode = 'restart-required'

  constructor(pluginId: string) {
    super(`插件 ${pluginId} 声明 restart-required，不能执行进程内切换`)
    this.name = 'PluginRestartRequiredError'
    this.pluginId = pluginId
  }
}

export class PluginDisableRejectedError extends Error {
  readonly code = 'product_plugin_required'
  readonly pluginId: string

  constructor(pluginId: string) {
    super(`产品运行所需插件不能通过普通管理操作停用：${pluginId}`)
    this.name = 'PluginDisableRejectedError'
    this.pluginId = pluginId
  }
}

export class PluginContractBlockedError extends Error {
  readonly code = 'plugin_contract_blocked'

  constructor(
    readonly pluginId: string,
    readonly diagnostics: readonly PluginContractDiagnostic[],
  ) {
    super(`插件契约阻止操作：${pluginId}（${diagnostics.map(item => `${item.pluginId}: ${item.message}`).join('；')}）`)
    this.name = 'PluginContractBlockedError'
  }
}

export class PluginRuntime {
  private readonly instances = new Map<string, PluginInstance>()
  private readonly definitions = new Map<string, BuiltinPluginDefinition>()
  private readonly knownDefinitions = new Map<string, BuiltinPluginDefinition>()
  private readonly listeners = new Set<() => void>()
  private readonly updateQueues = new Map<string, Promise<void>>()
  private readonly switchRecords = new Map<string, PluginSwitchDescriptor>()
  private readonly options: PluginRuntimeOptions
  private readonly host: PluginHostServices
  private readonly createContext: PluginActivationContextFactory
  private instanceSequence = 0
  private revision = 0
  private currentSnapshot: PluginRuntimeSnapshot = Object.freeze({
    revision: 0,
    active: Object.freeze([]),
    instances: Object.freeze([]),
    switches: Object.freeze([]),
  })

  constructor(options: PluginRuntimeOptions) {
    this.options = options
    this.host = options.host
    this.createContext = (identity, scope, transactions, definition) => (
      createPluginActivationContext(this.host, identity, scope, transactions, {
        definition,
        createManagementApi: this.options.createManagementApi,
      })
    )
  }

  snapshot(): PluginRuntimeSnapshot {
    return this.currentSnapshot
  }

  contractSnapshot(): readonly PluginContract[] {
    return Object.freeze(this.currentSnapshot.active.flatMap(identity => {
      const definition = this.definitions.get(identity.key)
      return definition ? [Object.freeze(this.toContract(definition))] : []
    }))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  private publishSnapshot(): void {
    this.revision += 1
    this.currentSnapshot = Object.freeze({
      revision: this.revision,
      active: Object.freeze([...this.instances.values()]
        .filter(instance => instance.status === 'active')
        .map(instance => instance.identity)
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      instances: Object.freeze([...this.instances.values()]
        .filter(instance => instance.status !== 'inactive')
        .map(instance => Object.freeze({
          identity: instance.identity,
          status: instance.status,
          cleanup: instance.cleanup,
        }))
        .sort((a, b) => a.identity.key.localeCompare(b.identity.key))),
      switches: Object.freeze([...this.switchRecords.values()]
        .sort((a, b) => a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0)),
    })
    for (const listener of [...this.listeners]) listener()
  }

  private assertInactive(pluginId: string): void {
    if ([...this.instances.values()].some(instance => (
      instance.identity.pluginId === pluginId && instance.status !== 'inactive'
    ))) {
      throw new Error(`插件已激活：${pluginId}`)
    }
  }

  async activateBuiltin(definition: BuiltinPluginDefinition): Promise<PluginInstance> {
    this.assertInactive(definition.id)
    this.assertContractGraph(definition)
    const identity = createPluginIdentity(definition.id, `builtin-${++this.instanceSequence}`)
    const instance = await activateBuiltinPlugin(identity, async context => {
      const prepared = await definition.prepare?.(context)
      await definition.activate(context, prepared)
    }, this.createContext, definition)
    this.instances.set(identity.key, instance)
    this.definitions.set(identity.key, definition)
    this.knownDefinitions.set(definition.id, definition)
    this.publishSnapshot()
    return instance
  }

  async activatePackage(definition: BuiltinPluginDefinition, identity?: PluginIdentity): Promise<PluginInstance> {
    this.assertInactive(definition.id)
    this.assertContractGraph(definition)
    const resolvedIdentity = identity ?? this.createIdentity(definition)
    const instance = await activateBuiltinPlugin(resolvedIdentity, async context => {
      const prepared = await definition.prepare?.(context)
      await definition.activate(context, prepared)
    }, this.createContext, definition)
    this.instances.set(resolvedIdentity.key, instance)
    this.definitions.set(resolvedIdentity.key, definition)
    this.knownDefinitions.set(definition.id, definition)
    this.publishSnapshot()
    return instance
  }

  /** 仅供明确要求同步完成的集成入口；Kernel bootstrap 不使用此路径。 */
  activateBuiltinSync(definition: BuiltinPluginDefinition): PluginInstance {
    this.assertInactive(definition.id)
    this.assertContractGraph(definition)
    if (definition.prepare) throw new Error(`同步激活不支持 prepare：${definition.id}`)
    const identity = definition.version && definition.packageInstanceId
      ? this.createIdentity(definition)
      : createPluginIdentity(definition.id, `builtin-${++this.instanceSequence}`)
    const scope = new PluginScope(identity.key)
    try {
      const result = definition.activate(
        this.createContext(identity, scope, undefined, definition),
      )
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        throw new Error(`同步激活要求 activate 同步返回：${definition.id}`)
      }
    } catch (error) {
      void scope.dispose()
      throw error
    }
    const instance: PluginInstance = { identity, scope, status: 'active' }
    this.instances.set(identity.key, instance)
    this.definitions.set(identity.key, definition)
    this.knownDefinitions.set(definition.id, definition)
    this.publishSnapshot()
    return instance
  }

  update(definition: BuiltinPluginDefinition, options: PluginUpdateOptions = {}): Promise<PluginUpdateResult> {
    const previous = this.updateQueues.get(definition.id) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => this.performUpdate(definition, options))
    const tail = operation.then(() => undefined, () => undefined)
    this.updateQueues.set(definition.id, tail)
    void tail.finally(() => {
      if (this.updateQueues.get(definition.id) === tail) this.updateQueues.delete(definition.id)
    })
    return operation
  }

  private async performUpdate(
    definition: BuiltinPluginDefinition,
    options: PluginUpdateOptions,
  ): Promise<PluginUpdateResult> {
    const oldInstance = [...this.instances.values()].find(instance => (
      instance.identity.pluginId === definition.id && instance.status === 'active'
    ))
    if (!oldInstance) throw new Error(`插件未激活：${definition.id}`)
    this.assertContractGraph(definition)
    if ((definition.hotSwapMode ?? 'parallel') === 'restart-required') {
      this.switchRecords.set(definition.id, Object.freeze({
        pluginId: definition.id,
        previousRuntimeInstanceId: oldInstance.identity.key,
        runtimeInstanceId: oldInstance.identity.key,
        declaredMode: 'restart-required',
        adoptedMode: 'restart-required',
        committedAt: Date.now(),
      }))
      this.publishSnapshot()
      throw new PluginRestartRequiredError(definition.id)
    }

    const oldDefinition = this.definitions.get(oldInstance.identity.key)
    if (!oldDefinition) throw new Error(`插件定义丢失：${oldInstance.identity.key}`)
    const candidateIdentity = options.identity ?? this.createIdentity(definition)
    if (candidateIdentity.pluginId !== definition.id) {
      throw new Error(`候选 identity 与 definition.id 不匹配：${candidateIdentity.pluginId}`)
    }
    if (candidateIdentity.key === oldInstance.identity.key) {
      throw new Error(`候选 runtimeInstanceId 必须唯一：${candidateIdentity.key}`)
    }

    const mode = definition.hotSwapMode ?? 'parallel'
    const scope = new PluginScope(candidateIdentity.key)
    const contributions = new PluginContributionTransaction(
      this.host,
      candidateIdentity,
      oldInstance.identity.key,
    )
    const context = this.createContext(candidateIdentity, scope, contributions.transactions, definition)
    let committed = false
    let suspended = false
    let remounted = false

    try {
      const prepared = await definition.prepare?.(context)
      await definition.activate(context, prepared)
      contributions.validate()

      if (mode === 'exclusive') {
        if (!oldDefinition.suspend || !oldDefinition.resume) {
          throw new Error(`exclusive 更新要求旧插件实现 suspend/resume：${definition.id}`)
        }
        await oldDefinition.suspend()
        suspended = true
      }

      contributions.commit()
      committed = true

      if (mode === 'soft-remount') {
        const remount = options.requestSoftRemount
          ?? this.options.requestSoftRemount
          ?? this.host.requestSoftRemount
        if (!remount) throw new Error(`soft-remount 更新缺少 Application 重挂入口：${definition.id}`)
        await remount()
        remounted = true
      }

      await this.host.hooks.drain(oldInstance.identity.key, definition.drainTimeoutMs)

      // Final fallible state commit. Old resources remain resumable until this succeeds.
      await options.commitActivePointer?.()

      const candidate: PluginInstance = { identity: candidateIdentity, scope, status: 'active' }
      this.instances.set(candidateIdentity.key, candidate)
      this.definitions.set(candidateIdentity.key, definition)
      this.knownDefinitions.set(definition.id, definition)
      const result: PluginUpdateResult = {
        pluginId: definition.id,
        previousRuntimeInstanceId: oldInstance.identity.key,
        runtimeInstanceId: candidateIdentity.key,
        declaredMode: mode,
        adoptedMode: mode,
      }
      const oldCleanup = await deactivatePluginInstance(oldInstance, oldDefinition.deactivate)
      if (oldCleanup.complete) {
        this.instances.delete(oldInstance.identity.key)
        this.definitions.delete(oldInstance.identity.key)
      }
      this.switchRecords.set(definition.id, Object.freeze({ ...result, committedAt: Date.now() }))
      this.publishSnapshot()
      return result
    } catch (error) {
      if (committed) contributions.revert()
      else contributions.rollback()
      await scope.dispose()
      if (suspended) await oldDefinition.resume?.()
      if (remounted) await (
        options.requestSoftRemount
        ?? this.options.requestSoftRemount
        ?? this.host.requestSoftRemount
      )?.()
      throw error
    }
  }

  async deactivate(instanceKey: string): Promise<PluginDeactivateResult> {
    const instance = this.instances.get(instanceKey)
    if (!instance) {
      return {
        complete: true,
        alreadyInactive: true,
        scope: { disposed: 0, remaining: 0, errors: [] },
      }
    }
    const result = await deactivatePluginInstance(instance, this.definitions.get(instanceKey)?.deactivate)
    if (result.complete) {
      this.instances.delete(instanceKey)
      this.definitions.delete(instanceKey)
    }
    this.publishSnapshot()
    return result
  }

  retryCleanup(instanceKey: string): Promise<PluginDeactivateResult> {
    return this.deactivate(instanceKey)
  }

  async disable(pluginId: string): Promise<PluginDeactivateResult> {
    const active = [...this.instances.values()].find(instance => (
      instance.identity.pluginId === pluginId && instance.status === 'active'
    ))
    if (!active) return {
      complete: true,
      alreadyInactive: true,
      scope: { disposed: 0, remaining: 0, errors: [] },
    }
    if (this.definitions.get(active.identity.key)?.criticality === 'product-required') {
      throw new PluginDisableRejectedError(pluginId)
    }
    return this.deactivate(active.identity.key)
  }

  async enable(pluginId: string): Promise<PluginInstance> {
    this.assertInactive(pluginId)
    const definition = this.knownDefinitions.get(pluginId)
    if (!definition) throw new Error(`插件没有可恢复定义：${pluginId}`)
    const fresh = this.withFreshRuntimeIdentity(definition)
    return definition.version && definition.packageInstanceId
      ? this.activatePackage(fresh)
      : this.activateBuiltin(fresh)
  }

  async reload(pluginId: string, mode?: HotSwapMode): Promise<PluginUpdateResult> {
    const active = [...this.instances.values()].find(instance => (
      instance.identity.pluginId === pluginId && instance.status === 'active'
    ))
    if (!active) throw new Error(`插件未激活：${pluginId}`)
    const definition = this.definitions.get(active.identity.key)
    if (!definition) throw new Error(`插件定义丢失：${active.identity.key}`)
    return this.update({
      ...this.withFreshRuntimeIdentity(definition),
      ...(mode ? { hotSwapMode: mode } : {}),
    })
  }

  private withFreshRuntimeIdentity(definition: BuiltinPluginDefinition): BuiltinPluginDefinition {
    const { runtimeInstanceId: _runtimeInstanceId, ...fresh } = definition
    return fresh
  }

  private assertContractGraph(candidate: BuiltinPluginDefinition): void {
    const contracts = new Map<string, PluginContract>()
    for (const identity of this.currentSnapshot.active) {
      const definition = this.definitions.get(identity.key)
      if (definition) contracts.set(definition.id, {
        ...this.toContract(definition),
        activationEvents: undefined,
      })
    }
    contracts.set(candidate.id, {
      ...this.toContract(candidate),
      activationEvents: undefined,
    })
    const resolution = resolvePluginContracts([...contracts.values()])
    if (resolution.blocked.length > 0) {
      throw new PluginContractBlockedError(candidate.id, resolution.blocked)
    }
  }

  private toContract(definition: BuiltinPluginDefinition): PluginContract {
    return {
      id: definition.id,
      version: definition.version ?? '0.0.0',
      enabled: true,
      dependencies: definition.dependencies,
      optionalDependencies: definition.optionalDependencies,
      conflicts: definition.conflicts,
      activationEvents: definition.activationEvents,
    }
  }

  private createIdentity(definition: BuiltinPluginDefinition): PluginIdentity {
    if (definition.version && definition.packageInstanceId) {
      return createPackagePluginIdentity({
        pluginId: definition.id,
        version: definition.version,
        packageInstanceId: definition.packageInstanceId,
        runtimeInstanceId: definition.runtimeInstanceId
          ?? `${definition.packageInstanceId}#run-${++this.instanceSequence}`,
      })
    }
    return createPluginIdentity(definition.id, `builtin-${++this.instanceSequence}`)
  }
}
