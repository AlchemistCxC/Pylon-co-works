import type { PluginIdentity } from '../pluginIdentity.ts'
import type {
  AsyncDisposable,
  ReactiveRegistry,
  RegisterOptions,
  RegistryEntry,
  RegistryLayer,
  RegistrySnapshot,
  RegistryTransaction,
} from './types.ts'
import { notifyRegistryListener } from './registryBatch.ts'

const DEFAULT_PRIORITY = 1000
const LAYER_ORDER: Record<RegistryLayer, number> = {
  platform: 0,
  feature: 1,
  override: 2,
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function orderEntries<T>(entries: readonly RegistryEntry<T>[]): RegistryEntry<T>[] {
  const byId = new Map<string, RegistryEntry<T>>()
  for (const entry of entries) {
    if (!entry.contributionId) throw new Error('contributionId 不能为空')
    if (byId.has(entry.contributionId)) {
      throw new Error(`ReactiveRegistry contributionId 重复：${entry.contributionId}`)
    }
    byId.set(entry.contributionId, entry)
  }

  const indegree = new Map<string, number>()
  const outgoing = new Map<string, Set<string>>()
  for (const entry of entries) {
    indegree.set(entry.contributionId, 0)
    outgoing.set(entry.contributionId, new Set())
  }

  const addEdge = (beforeId: string, afterId: string) => {
    if (beforeId === afterId) {
      throw new Error(`ReactiveRegistry 排序约束自引用：${beforeId}`)
    }
    if (!byId.has(beforeId) || !byId.has(afterId)) {
      const missing = byId.has(beforeId) ? afterId : beforeId
      throw new Error(`ReactiveRegistry 排序约束引用未知 id：${missing}`)
    }
    const targets = outgoing.get(beforeId)!
    if (targets.has(afterId)) return
    targets.add(afterId)
    indegree.set(afterId, (indegree.get(afterId) ?? 0) + 1)
  }

  for (const entry of entries) {
    for (const beforeId of entry.before ?? []) addEdge(entry.contributionId, beforeId)
    for (const afterId of entry.after ?? []) addEdge(afterId, entry.contributionId)
  }

  const ready = entries.filter(entry => indegree.get(entry.contributionId) === 0)
  const ordered: RegistryEntry<T>[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => {
      const layerDelta = LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]
      if (layerDelta !== 0) return layerDelta
      const priorityDelta = a.priority - b.priority
      if (priorityDelta !== 0) return priorityDelta
      const pluginDelta = compareIds(a.ownerPluginId, b.ownerPluginId)
      return pluginDelta !== 0 ? pluginDelta : compareIds(a.contributionId, b.contributionId)
    })
    const next = ready.shift()!
    ordered.push(next)
    for (const targetId of outgoing.get(next.contributionId) ?? []) {
      const nextDegree = (indegree.get(targetId) ?? 1) - 1
      indegree.set(targetId, nextDegree)
      if (nextDegree === 0) ready.push(byId.get(targetId)!)
    }
  }

  if (ordered.length !== entries.length) {
    const remaining = entries
      .filter(entry => (indegree.get(entry.contributionId) ?? 0) > 0)
      .map(entry => entry.contributionId)
      .sort(compareIds)
    throw new Error(`ReactiveRegistry 排序约束成环：${remaining.join(', ')}`)
  }
  return ordered
}

function createEntry<T>(owner: PluginIdentity, value: T, options: RegisterOptions): RegistryEntry<T> {
  if (!options.contributionId) throw new Error('contributionId 不能为空')
  return Object.freeze({
    ownerPluginId: owner.pluginId,
    ownerRuntimeInstanceId: owner.key,
    contributionId: options.contributionId,
    layer: options.layer ?? 'feature',
    priority: options.priority ?? DEFAULT_PRIORITY,
    ...(options.before ? { before: Object.freeze([...options.before]) } : {}),
    ...(options.after ? { after: Object.freeze([...options.after]) } : {}),
    value,
  })
}

export class ReactiveRegistryStore<T> implements ReactiveRegistry<T> {
  private readonly entries = new Map<string, RegistryEntry<T>>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private snapshot: RegistrySnapshot<T> = Object.freeze({ revision: 0, entries: Object.freeze([]) })

  register(owner: PluginIdentity, value: T, options: RegisterOptions): AsyncDisposable {
    const entry = createEntry(owner, value, options)
    this.commitEntries([entry])
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        if (this.entries.get(entry.contributionId) !== entry) return
        this.entries.delete(entry.contributionId)
        this.publish()
      },
    }
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

  getSnapshot(): RegistrySnapshot<T> {
    return this.snapshot
  }

  beginTransaction(owner: PluginIdentity): RegistryTransaction<T> {
    return this.createTransaction(owner)
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<T> {
    if (!replacingRuntimeInstanceId) throw new Error('replacingRuntimeInstanceId 不能为空')
    return this.createTransaction(owner, replacingRuntimeInstanceId)
  }

  private createTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId?: string,
  ): RegistryTransaction<T> {
    const staged: Array<{ entry: RegistryEntry<T>, proxy: AsyncDisposable, cancelled: boolean }> = []
    let settled = false
    let committed = false
    let reverted = false
    let previousEntries: Map<string, RegistryEntry<T>> | undefined

    const candidateEntries = () => {
      const candidate = new Map(this.entries)
      if (replacingRuntimeInstanceId) {
        for (const [id, entry] of candidate) {
          if (entry.ownerRuntimeInstanceId === replacingRuntimeInstanceId) candidate.delete(id)
        }
      }
      for (const item of staged) {
        if (item.cancelled) continue
        if (candidate.has(item.entry.contributionId)) {
          throw new Error(`ReactiveRegistry contributionId 重复：${item.entry.contributionId}`)
        }
        candidate.set(item.entry.contributionId, item.entry)
      }
      return candidate
    }

    return {
      owner,
      register: (value, options) => {
        if (settled) throw new Error(`Registry transaction 已结算：${owner.key}`)
        const item = {
          entry: createEntry(owner, value, options),
          cancelled: false,
          proxy: undefined as unknown as AsyncDisposable,
        }
        item.proxy = {
          dispose: () => {
            if (item.cancelled) return
            item.cancelled = true
            if (!committed || this.entries.get(item.entry.contributionId) !== item.entry) return
            this.entries.delete(item.entry.contributionId)
            this.publish()
          },
        }
        staged.push(item)
        return item.proxy
      },
      validate: () => {
        if (settled) throw new Error(`Registry transaction 已结算：${owner.key}`)
        orderEntries([...candidateEntries().values()])
      },
      commit: () => {
        if (settled) throw new Error(`Registry transaction 已结算：${owner.key}`)
        const candidate = candidateEntries()
        orderEntries([...candidate.values()])
        settled = true
        committed = true
        previousEntries = new Map(this.entries)
        this.entries.clear()
        for (const [id, entry] of candidate) this.entries.set(id, entry)
        if (staged.some(item => !item.cancelled) || replacingRuntimeInstanceId) this.publish()
        return staged.filter(item => !item.cancelled).map(item => item.proxy)
      },
      rollback: () => {
        if (settled) throw new Error(`Registry transaction 已结算：${owner.key}`)
        settled = true
      },
      revert: () => {
        if (!committed || !previousEntries) {
          throw new Error(`Registry transaction 尚未 commit：${owner.key}`)
        }
        if (reverted) return
        reverted = true
        this.entries.clear()
        for (const [id, entry] of previousEntries) this.entries.set(id, entry)
        this.publish()
      },
    }
  }

  private commitEntries(entries: readonly RegistryEntry<T>[]): void {
    const candidate = new Map(this.entries)
    for (const entry of entries) {
      if (candidate.has(entry.contributionId)) {
        throw new Error(`ReactiveRegistry contributionId 重复：${entry.contributionId}`)
      }
      candidate.set(entry.contributionId, entry)
    }
    orderEntries([...candidate.values()])
    for (const entry of entries) this.entries.set(entry.contributionId, entry)
    if (entries.length > 0) this.publish()
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = Object.freeze({
      revision: this.revision,
      entries: Object.freeze(orderEntries([...this.entries.values()])),
    })
    for (const listener of [...this.listeners]) notifyRegistryListener(listener)
  }
}
