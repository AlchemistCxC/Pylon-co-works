import { applicationRuntime } from '../../application/applicationRuntimeServices.ts'
import { createPluginActivationContext, type PluginActivationContextFactory } from '../pluginActivationContext.ts'
import type { PluginHostServices } from '../pluginHostServices.ts'
import { getPluginProcessClient } from '../process/processRuntimeServices.ts'
import { PluginRuntime, type PluginRuntimeOptions } from '../pluginRuntime.ts'
import {
  activateBuiltinPlugin,
  type BuiltinPluginActivate,
  type PluginInstance,
} from '../pluginInstance.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import { getRuntimeServices } from '../runtimeServices.ts'

export function createTestPluginHostServices(): PluginHostServices {
  const registries = getRuntimeServices()
  return {
    application: applicationRuntime,
    registries,
    hooks: registries.hookRuntime,
    processClient: getPluginProcessClient(),
  }
}

export function createTestPluginRuntime(
  options: Omit<PluginRuntimeOptions, 'host'> = {},
): PluginRuntime {
  return new PluginRuntime({ host: createTestPluginHostServices(), ...options })
}

export class TestPluginRuntime extends PluginRuntime {
  constructor(options: Omit<PluginRuntimeOptions, 'host'> = {}) {
    super({ host: createTestPluginHostServices(), ...options })
  }
}

export function createTestPluginActivationContextFactory(): PluginActivationContextFactory {
  const host = createTestPluginHostServices()
  return (identity, scope, transactions) => (
    createPluginActivationContext(host, identity, scope, transactions)
  )
}

export function activateTestBuiltinPlugin(
  identity: PluginIdentity,
  activate: BuiltinPluginActivate,
): Promise<PluginInstance> {
  return activateBuiltinPlugin(identity, activate, createTestPluginActivationContextFactory())
}
