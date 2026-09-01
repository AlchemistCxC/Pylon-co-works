import type { ComponentType } from 'react'
import type { PluginIdentity } from '../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../plugin-runtime/registry/types.ts'
import { notifyRegistryListener } from './registryBatch.ts'

export interface Disposable { dispose: () => void }
export interface ApplicationContribution { id: string; component: ComponentType }
export interface ApplicationRuntimeSnapshot {
  activeApplicationId: string | null
  registeredApplicationIds: readonly string[]
  revision: number
}
export interface ApplicationRegistryEntry {
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly contribution: ApplicationContribution
}
export interface ApplicationRegistryTransaction {
  register(contribution: ApplicationContribution): AsyncDisposable
  validate(): void
  commit(): void
  rollback(): void
  revert(): void
}
export interface ApplicationRuntime {
  registerBuiltin: (contribution: ApplicationContribution) => Disposable
  register: (owner: PluginIdentity, contribution: ApplicationContribution) => AsyncDisposable
  beginShadowTransaction: (owner: PluginIdentity, replacingRuntimeInstanceId: string) => ApplicationRegistryTransaction
  mount: (applicationId: string) => void
  unmount: () => void
  resolve: (applicationId: string) => ApplicationContribution | null
  getSnapshot: () => ApplicationRuntimeSnapshot
  subscribe: (listener: () => void) => () => void
}

export function createApplicationRuntime(): ApplicationRuntime {
  const contributions = new Map<string, ApplicationRegistryEntry>()
  const listeners = new Set<() => void>()
  let snapshot: ApplicationRuntimeSnapshot = {
    activeApplicationId: null,
    registeredApplicationIds: Object.freeze([]),
    revision: 0,
  }
  const publish = (activeApplicationId: string | null) => {
    snapshot = Object.freeze({
      activeApplicationId,
      registeredApplicationIds: Object.freeze([...contributions.keys()].sort()),
      revision: snapshot.revision + 1,
    })
    listeners.forEach(listener => notifyRegistryListener(listener))
  }
  const normalize = (contribution: ApplicationContribution): ApplicationContribution => {
    if (!contribution.id.trim()) throw new Error('Application id 不能为空')
    if (typeof contribution.component !== 'function' && typeof contribution.component !== 'object') {
      throw new Error(`Application component 非法：${contribution.id}`)
    }
    return Object.freeze({ ...contribution })
  }
  const register = (owner: PluginIdentity, contribution: ApplicationContribution): AsyncDisposable => {
    const normalized = normalize(contribution)
    if (contributions.has(normalized.id)) throw new Error(`Application 已注册：${normalized.id}`)
    const entry = Object.freeze({
      ownerPluginId: owner.pluginId,
      ownerRuntimeInstanceId: owner.key,
      contribution: normalized,
    })
    contributions.set(normalized.id, entry)
    publish(snapshot.activeApplicationId)
    let disposed = false
    return { dispose: () => {
      if (disposed) return
      disposed = true
      if (contributions.get(normalized.id) !== entry) return
      contributions.delete(normalized.id)
      publish(snapshot.activeApplicationId === normalized.id ? null : snapshot.activeApplicationId)
    } }
  }
  return {
    registerBuiltin(contribution) {
      return register({
        pluginId: 'kernel.application-test', version: 'builtin', packageInstanceId: 'kernel.application-test@builtin',
        runtimeInstanceId: `kernel.application-test@${contribution.id}`, instanceId: contribution.id,
        key: `kernel.application-test@${contribution.id}`,
      }, contribution)
    },
    register,
    beginShadowTransaction(owner, replacingRuntimeInstanceId) {
      if (!replacingRuntimeInstanceId) throw new Error('replacingRuntimeInstanceId 不能为空')
      const staged: Array<{ entry: ApplicationRegistryEntry; proxy: AsyncDisposable; cancelled: boolean }> = []
      let settled = false; let committed = false; let reverted = false
      let previousEntries: Map<string, ApplicationRegistryEntry> | undefined
      let previousActiveApplicationId: string | null | undefined
      const candidate = () => {
        const next = new Map(contributions)
        for (const [id, entry] of next) if (entry.ownerRuntimeInstanceId === replacingRuntimeInstanceId) next.delete(id)
        for (const item of staged) {
          if (item.cancelled) continue
          const id = item.entry.contribution.id
          if (next.has(id)) throw new Error(`Application 已注册：${id}`)
          next.set(id, item.entry)
        }
        return next
      }
      return {
        register: contribution => {
          if (settled) throw new Error(`Application transaction 已结算：${owner.key}`)
          const entry = Object.freeze({ ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key, contribution: normalize(contribution) })
          const item = { entry, cancelled: false, proxy: undefined as unknown as AsyncDisposable }
          item.proxy = { dispose: () => {
            if (item.cancelled) return
            item.cancelled = true
            const id = entry.contribution.id
            if (!committed || contributions.get(id) !== entry) return
            contributions.delete(id); publish(snapshot.activeApplicationId === id ? null : snapshot.activeApplicationId)
          } }
          staged.push(item); return item.proxy
        },
        validate: () => { if (settled) throw new Error(`Application transaction 已结算：${owner.key}`); candidate() },
        commit: () => {
          if (settled) throw new Error(`Application transaction 已结算：${owner.key}`)
          const next = candidate(); settled = true; committed = true
          previousEntries = new Map(contributions); previousActiveApplicationId = snapshot.activeApplicationId
          contributions.clear(); for (const [id, entry] of next) contributions.set(id, entry)
          const active = snapshot.activeApplicationId && contributions.has(snapshot.activeApplicationId) ? snapshot.activeApplicationId : null
          publish(active)
        },
        rollback: () => { if (settled) throw new Error(`Application transaction 已结算：${owner.key}`); settled = true },
        revert: () => {
          if (!committed || !previousEntries || previousActiveApplicationId === undefined) throw new Error(`Application transaction 尚未 commit：${owner.key}`)
          if (reverted) return; reverted = true; contributions.clear()
          for (const [id, entry] of previousEntries) contributions.set(id, entry)
          publish(previousActiveApplicationId)
        },
      }
    },
    mount(applicationId) {
      if (!contributions.has(applicationId)) throw new Error(`Application 未注册：${applicationId}`)
      if (snapshot.activeApplicationId === applicationId) return
      publish(applicationId)
    },
    unmount() { if (snapshot.activeApplicationId === null) return; publish(null) },
    resolve(applicationId) { return contributions.get(applicationId)?.contribution ?? null },
    getSnapshot() { return snapshot },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
