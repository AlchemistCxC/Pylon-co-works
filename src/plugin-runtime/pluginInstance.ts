import type { PluginIdentity } from './pluginIdentity.ts'
import type { PluginCleanupError, PluginScopeDisposeResult } from './pluginScope.ts'
import { createPluginActivationTransaction } from './pluginTransaction.ts'
import {
  type BuiltinPluginActivationContext,
  type PluginActivationContextFactory,
} from './pluginActivationContext.ts'

export type { BuiltinPluginActivationContext } from './pluginActivationContext.ts'

export type PluginInstanceStatus = 'active' | 'deactivating' | 'inactive' | 'cleanup-failed'

export type BuiltinPluginActivate = (
  context: BuiltinPluginActivationContext,
  prepared?: unknown,
) => void | Promise<void>

export interface PluginInstance {
  readonly identity: PluginIdentity
  readonly scope: BuiltinPluginActivationContext['scope']
  status: PluginInstanceStatus
  deactivateHookComplete?: boolean
  deactivateHookError?: PluginCleanupError
  cleanup?: PluginDeactivateResult
}

export interface PluginDeactivateResult {
  readonly complete: boolean
  readonly alreadyInactive: boolean
  readonly deactivateError?: PluginCleanupError
  readonly scope: PluginScopeDisposeResult
}

export async function activateBuiltinPlugin(
  identity: PluginIdentity,
  activate: BuiltinPluginActivate,
  createContext: PluginActivationContextFactory,
): Promise<PluginInstance> {
  const transaction = createPluginActivationTransaction(identity)
  try {
    await activate(createContext(identity, transaction.scope))
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
    return {
      complete: true,
      alreadyInactive: true,
      scope: { disposed: 0, remaining: 0, errors: [] },
    }
  }
  if (instance.status === 'deactivating') {
    throw new Error(`插件正在停用：${instance.identity.key}`)
  }

  instance.status = 'deactivating'
  if (!instance.deactivateHookComplete) {
    try {
      await deactivate?.()
      instance.deactivateHookComplete = true
      instance.deactivateHookError = undefined
    } catch (error) {
      instance.deactivateHookError = Object.freeze({
        resourceId: 'deactivate-hook',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const scope = await instance.scope.dispose()
  const complete = instance.deactivateHookComplete === true && scope.remaining === 0
  instance.status = complete ? 'inactive' : 'cleanup-failed'
  const result: PluginDeactivateResult = {
    complete,
    alreadyInactive: false,
    deactivateError: instance.deactivateHookError,
    scope,
  }
  instance.cleanup = result
  return result
}
