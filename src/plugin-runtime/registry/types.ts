import type { PluginIdentity } from '../pluginIdentity.ts'

export type RegistryLayer = 'platform' | 'feature' | 'override'

export interface AsyncDisposable {
  dispose(): void | Promise<void>
}

export interface RegisterOptions {
  contributionId: string
  layer?: RegistryLayer
  priority?: number
  before?: readonly string[]
  after?: readonly string[]
}

export interface RegistryEntry<T> {
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly contributionId: string
  readonly layer: RegistryLayer
  readonly priority: number
  readonly before?: readonly string[]
  readonly after?: readonly string[]
  readonly value: T
}

export interface RegistrySnapshot<T> {
  readonly revision: number
  readonly entries: readonly RegistryEntry<T>[]
}

export interface RegistryTransaction<T> {
  readonly owner: PluginIdentity
  register(value: T, options: RegisterOptions): AsyncDisposable
  validate(): void
  commit(): readonly AsyncDisposable[]
  rollback(): void
  /** Restore the exact pre-commit snapshot when a later update step fails. */
  revert(): void
}

export interface ReactiveRegistry<T> {
  register(owner: PluginIdentity, value: T, options: RegisterOptions): AsyncDisposable
  subscribe(listener: () => void): () => void
  getSnapshot(): RegistrySnapshot<T>
  beginTransaction(owner: PluginIdentity): RegistryTransaction<T>
  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<T>
}
