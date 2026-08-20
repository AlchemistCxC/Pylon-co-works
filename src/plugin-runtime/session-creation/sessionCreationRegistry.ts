import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { SessionCreationArtifactHandler, SessionCreationCompiler, SessionCreationContribution } from './sessionCreationTypes.ts'

const NAMESPACED_KIND = /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9._-]*)+$/

function validateId(id: string, label: string): void {
  if (!id || id !== id.trim()) throw new Error(`${label} id 非法`)
}

function validateKind(kind: string, label: string): void {
  if (!NAMESPACED_KIND.test(kind)) throw new Error(`${label} kind 必须是 namespaced path：${kind}`)
}

function validateOrder(order: number | undefined, label: string): void {
  if (order !== undefined && !Number.isFinite(order)) throw new Error(`${label} order 非法`)
}

export function validateSessionCreationContribution(
  contribution: SessionCreationContribution,
): SessionCreationContribution {
  validateId(contribution.id, 'Session creation contribution')
  validateKind(contribution.kind, `Session creation contribution ${contribution.id}`)
  validateOrder(contribution.order, `Session creation contribution ${contribution.id}`)
  if (typeof contribution.payload !== 'function' && contribution.payload === undefined) {
    throw new Error(`Session creation contribution payload 缺失：${contribution.id}`)
  }
  return Object.freeze({ ...contribution })
}

export function validateSessionCreationCompiler(compiler: SessionCreationCompiler): SessionCreationCompiler {
  validateId(compiler.id, 'Session creation compiler')
  validateKind(compiler.kind, `Session creation compiler ${compiler.id}`)
  validateOrder(compiler.order, `Session creation compiler ${compiler.id}`)
  if (typeof compiler.compile !== 'function') throw new Error(`Session creation compiler compile 缺失：${compiler.id}`)
  return Object.freeze({ ...compiler })
}

export function validateSessionCreationArtifactHandler(handler: SessionCreationArtifactHandler): SessionCreationArtifactHandler {
  validateId(handler.id, 'Session creation artifact handler')
  validateKind(handler.phase, `Session creation artifact handler ${handler.id} phase`)
  validateKind(handler.kind, `Session creation artifact handler ${handler.id} kind`)
  validateOrder(handler.order, `Session creation artifact handler ${handler.id}`)
  if (typeof handler.run !== 'function') throw new Error(`Session creation artifact handler run 缺失：${handler.id}`)
  return Object.freeze({ ...handler })
}

export interface SessionCreationRegistrySnapshot {
  readonly revision: number
  readonly contributions: RegistrySnapshot<SessionCreationContribution>
  readonly compilers: RegistrySnapshot<SessionCreationCompiler>
  readonly handlers: RegistrySnapshot<SessionCreationArtifactHandler>
}

export interface SessionCreationRegistryTransaction {
  readonly owner: PluginIdentity
  registerContribution(contribution: SessionCreationContribution): AsyncDisposable
  registerCompiler(compiler: SessionCreationCompiler): AsyncDisposable
  registerArtifactHandler(handler: SessionCreationArtifactHandler): AsyncDisposable
  validate(): void
  commit(): readonly AsyncDisposable[]
  rollback(): void
  revert(): void
}

function wrapContributionTransaction(
  transaction: RegistryTransaction<SessionCreationContribution>,
): RegistryTransaction<SessionCreationContribution> {
  return {
    ...transaction,
    register: (contribution, options) => {
      const normalized = validateSessionCreationContribution(contribution)
      return transaction.register(normalized, {
        ...options,
        contributionId: normalized.id,
        priority: normalized.order,
      })
    },
  }
}

function wrapCompilerTransaction(
  transaction: RegistryTransaction<SessionCreationCompiler>,
): RegistryTransaction<SessionCreationCompiler> {
  return {
    ...transaction,
    register: (compiler, options) => {
      const normalized = validateSessionCreationCompiler(compiler)
      return transaction.register(normalized, {
        ...options,
        contributionId: normalized.id,
        priority: normalized.order,
      })
    },
  }
}

export class SessionCreationRegistry {
  private readonly contributions = new ReactiveRegistryStore<SessionCreationContribution>()
  private readonly compilers = new ReactiveRegistryStore<SessionCreationCompiler>()
  private readonly handlers = new ReactiveRegistryStore<SessionCreationArtifactHandler>()

  registerContribution(owner: PluginIdentity, contribution: SessionCreationContribution): AsyncDisposable {
    const normalized = validateSessionCreationContribution(contribution)
    return this.contributions.register(owner, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  registerCompiler(owner: PluginIdentity, compiler: SessionCreationCompiler): AsyncDisposable {
    const normalized = validateSessionCreationCompiler(compiler)
    return this.compilers.register(owner, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  registerArtifactHandler(owner: PluginIdentity, handler: SessionCreationArtifactHandler): AsyncDisposable {
    const normalized = validateSessionCreationArtifactHandler(handler)
    return this.handlers.register(owner, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): SessionCreationRegistryTransaction {
    const contribution = wrapContributionTransaction(
      this.contributions.beginShadowTransaction(owner, replacingRuntimeInstanceId),
    )
    const compiler = wrapCompilerTransaction(
      this.compilers.beginShadowTransaction(owner, replacingRuntimeInstanceId),
    )
    const handlerBase = this.handlers.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const handler: RegistryTransaction<SessionCreationArtifactHandler> = {
      ...handlerBase,
      register: (value, options) => {
        const normalized = validateSessionCreationArtifactHandler(value)
        return handlerBase.register(normalized, {
          ...options,
          contributionId: normalized.id,
          priority: normalized.order,
        })
      },
    }
    const committed = { contribution: false, compiler: false, handler: false }
    const revertCommitted = () => {
      const errors: unknown[] = []
      for (const [key, value] of [
        ['handler', handler],
        ['compiler', compiler],
        ['contribution', contribution],
      ] as const) {
        if (!committed[key]) continue
        try { value.revert() } catch (error) { errors.push(error) }
        committed[key] = false
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Session creation shadow transaction revert 失败')
    }
    return {
      owner,
      registerContribution: value => contribution.register(value, {
        contributionId: value.id,
        priority: value.order,
      }),
      registerCompiler: value => compiler.register(value, {
        contributionId: value.id,
        priority: value.order,
      }),
      registerArtifactHandler: value => handler.register(value, {
        contributionId: value.id,
        priority: value.order,
      }),
      validate() { contribution.validate(); compiler.validate(); handler.validate() },
      commit() {
        const registrations: AsyncDisposable[] = []
        try {
          registrations.push(...contribution.commit()); committed.contribution = true
          registrations.push(...compiler.commit()); committed.compiler = true
          registrations.push(...handler.commit()); committed.handler = true
          return registrations
        } catch (error) {
          try { revertCommitted() } catch { /* retain original commit error */ }
          throw error
        }
      },
      rollback() { contribution.rollback(); compiler.rollback(); handler.rollback() },
      revert: revertCommitted,
    }
  }

  subscribe(listener: () => void): () => void {
    const disposeContributions = this.contributions.subscribe(listener)
    const disposeCompilers = this.compilers.subscribe(listener)
    const disposeHandlers = this.handlers.subscribe(listener)
    return () => { disposeHandlers(); disposeCompilers(); disposeContributions() }
  }

  getSnapshot(): SessionCreationRegistrySnapshot {
    const contributions = this.contributions.getSnapshot()
    const compilers = this.compilers.getSnapshot()
    const handlers = this.handlers.getSnapshot()
    return Object.freeze({
      revision: contributions.revision + compilers.revision + handlers.revision,
      contributions,
      compilers,
      handlers,
    })
  }
}
