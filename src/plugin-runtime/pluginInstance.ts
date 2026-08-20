import type { PluginIdentity } from './pluginIdentity.ts'
import type { PluginScopeDisposeResult } from './pluginScope.ts'
import { createPluginActivationTransaction } from './pluginTransaction.ts'
import {
  createPluginActivationContext,
  type BuiltinPluginActivationContext,
} from './pluginActivationContext.ts'

export type { BuiltinPluginActivationContext } from './pluginActivationContext.ts'

export type PluginInstanceStatus = 'active' | 'deactivating' | 'inactive'

export type BuiltinPluginActivate = (
  context: BuiltinPluginActivationContext,
  prepared?: unknown,
) => void | Promise<void>

export interface PluginInstance {
  readonly identity: PluginIdentity
  readonly scope: BuiltinPluginActivationContext['scope']
  status: PluginInstanceStatus
}

export interface PluginDeactivateResult {
  alreadyInactive: boolean
  deactivateError?: unknown
  scope: PluginScopeDisposeResult
}

export async function activateBuiltinPlugin(
  identity: PluginIdentity,
  activate: BuiltinPluginActivate,
): Promise<PluginInstance> {
  const transaction = createPluginActivationTransaction(identity)
  try {
    await activate(createPluginActivationContext(identity, transaction.scope))
    return {
      identity,
      scope: transaction.commit(),
      status: 'active',
    }
  } catch (error) {
    return transaction.rollback(error)
  }
}

export async function deactivatePluginInstance(
  instance: PluginInstance,
  deactivate?: () => void | Promise<void>,
): Promise<PluginDeactivateResult> {
  if (instance.status === 'inactive') {
    return { alreadyInactive: true, scope: { disposed: 0, errors: [] } }
  }
  if (instance.status === 'deactivating') {
    throw new Error(`插件正在停用：${instance.identity.key}`)
  }

  instance.status = 'deactivating'
  let deactivateError: unknown
  try {
    await deactivate?.()
  } catch (error) {
    deactivateError = error
  }
  const scope = await instance.scope.dispose()
  instance.status = 'inactive'
  return {
    alreadyInactive: false,
    deactivateError,
    scope,
  }
}
