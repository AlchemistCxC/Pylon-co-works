import type { PluginIdentity } from './pluginIdentity.ts'
import { PluginScope, type PluginScopeDisposeResult } from './pluginScope.ts'

export class PluginActivationError extends Error {
  readonly identity: PluginIdentity
  readonly cause: unknown
  readonly rollback: PluginScopeDisposeResult

  constructor(identity: PluginIdentity, cause: unknown, rollback: PluginScopeDisposeResult) {
    super(`插件 ${identity.key} activation 失败`)
    this.name = 'PluginActivationError'
    this.identity = identity
    this.cause = cause
    this.rollback = rollback
  }
}

export interface PluginActivationTransaction {
  readonly identity: PluginIdentity
  readonly scope: PluginScope
  commit: () => PluginScope
  rollback: (cause: unknown) => Promise<never>
}

export function createPluginActivationTransaction(identity: PluginIdentity): PluginActivationTransaction {
  const scope = new PluginScope(identity.key)
  let settled = false
  return {
    identity,
    scope,
    commit() {
      if (settled) throw new Error(`Plugin transaction 已结算：${identity.key}`)
      settled = true
      return scope
    },
    async rollback(cause) {
      if (settled) throw new Error(`Plugin transaction 已结算：${identity.key}`)
      settled = true
      const rollback = await scope.dispose()
      throw new PluginActivationError(identity, cause, rollback)
    },
  }
}
