import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'

export type PluginServiceKind =
  | 'search'
  | 'export'
  | 'event-projector'
  | 'session-state'
  | 'agent-detector'
  | 'agent-instance-sink'
  | 'tool-dictionary-sink'

export type PluginServiceResolutionErrorCode =
  | 'plugin_service_unavailable'
  | 'plugin_service_ambiguous'

export class PluginServiceResolutionError extends Error {
  constructor(
    readonly code: PluginServiceResolutionErrorCode,
    readonly kind: PluginServiceKind,
    readonly serviceId: string | undefined,
    readonly matchCount: number,
    readonly matchingServiceIds: readonly string[],
  ) {
    const target = serviceId ? `${kind}:${serviceId}` : kind
    super(code === 'plugin_service_unavailable'
      ? `必需插件服务不可用：${target}`
      : `必需插件服务不唯一：${target}（匹配 ${matchCount} 项：${matchingServiceIds.join(', ')}）`)
    this.name = 'PluginServiceResolutionError'
  }
}

export interface PluginServiceContribution<T = unknown> {
  readonly kind: PluginServiceKind
  readonly id: string
  readonly value: T
}

export class PluginServiceRegistry {
  private readonly registry = new ReactiveRegistryStore<PluginServiceContribution>()

  register<T>(identity: PluginIdentity, contribution: PluginServiceContribution<T>): AsyncDisposable {
    this.validate(contribution)
    return this.registry.register(identity, Object.freeze({ ...contribution }), {
      contributionId: `${contribution.kind}:${contribution.id}`,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<PluginServiceContribution> {
    return this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
  }

  getSnapshot(): RegistrySnapshot<PluginServiceContribution> {
    return this.registry.getSnapshot()
  }

  list<T>(kind: PluginServiceKind): T[] {
    return this.registry.getSnapshot().entries
      .filter(entry => entry.value.kind === kind)
      .map(entry => entry.value.value as T)
  }

  resolveRequired<T>(kind: PluginServiceKind, id?: string): T {
    const matches = this.registry.getSnapshot().entries.filter(entry => (
      entry.value.kind === kind && (id === undefined || entry.value.id === id)
    ))
    if (matches.length !== 1) {
      throw new PluginServiceResolutionError(
        matches.length === 0 ? 'plugin_service_unavailable' : 'plugin_service_ambiguous',
        kind,
        id,
        matches.length,
        Object.freeze(matches.map(entry => entry.value.id).sort()),
      )
    }
    return matches[0].value.value as T
  }

  private validate(contribution: PluginServiceContribution): void {
    if (!contribution.id) throw new Error('Plugin service id 不能为空')
    if (!contribution.kind) throw new Error(`Plugin service ${contribution.id} 缺少 kind`)
  }
}
