/** API 1.0 plugin composition root: the only product runtime and package owner. */
import { invoke } from '@tauri-apps/api/core'
import {
  applicationRuntime,
  requestApplicationSoftRemount,
} from '../kernel/applicationRuntimeServices.ts'
import { createPluginPackageClient, type PluginPackageClient } from '../infrastructure/plugins/pluginPackageClient.ts'
import type { PluginProcessClient } from '../infrastructure/plugins/pluginProcessClient.ts'
import { createSkinHostPorts } from '../infrastructure/skin/skinHostPorts.ts'
import { getSkinRuntime } from '../infrastructure/skin/skinRuntimeServices.ts'
import { createBuiltinProductPluginDefinitions } from '../plugins/product/builtinProductPlugins.ts'
import { shouldExposeKernelAcceptanceControls } from '../kernel/kernelAcceptanceControls.ts'
import { PackagePluginRuntimeService } from './packagePluginRuntime.ts'
import { PackageInstallationService } from './packageInstallationService.ts'
import { getPluginProcessClient as getRuntimePluginProcessClient } from './process/processRuntimeServices.ts'
import { PluginRuntime, type BuiltinPluginDefinition } from './pluginRuntime.ts'
import {
  bootstrapPluginDefinitions,
  type BuiltinPluginBootstrapResult,
} from './builtinPluginBootstrap.ts'
import { bindPluginDisableHandler, getRuntimeServices } from './runtimeServices.ts'
import { BUILTIN_SKIN_PLUGIN_ID, createBuiltinSkinPluginDefinition } from './skin/builtinSkinPlugin.ts'

const runtimeServices = getRuntimeServices()
const pluginHostServices = Object.freeze({
  application: applicationRuntime,
  registries: runtimeServices,
  hooks: runtimeServices.hookRuntime,
  processClient: getRuntimePluginProcessClient(),
  requestSoftRemount: requestApplicationSoftRemount,
})
const pluginRuntime = new PluginRuntime({ host: pluginHostServices })
bindPluginDisableHandler(async pluginId => {
  const result = await pluginRuntime.disable(pluginId)
  if (result.complete) return
  const messages = [result.deactivateError, ...result.scope.errors]
    .filter(error => error !== undefined)
    .map(error => `${error.resourceId}: ${error.message}`)
  throw new Error(`Plugin cleanup incomplete: ${pluginId}${messages.length > 0 ? ` (${messages.join('; ')})` : ''}`)
})
const definitions = new Map<string, BuiltinPluginDefinition>()

for (const definition of createBuiltinProductPluginDefinitions()) definitions.set(definition.id, definition)
definitions.set(
  BUILTIN_SKIN_PLUGIN_ID,
  {
    ...createBuiltinSkinPluginDefinition(getSkinRuntime(), createSkinHostPorts(getSkinRuntime())),
    criticality: 'optional',
  },
)

export function getPluginRuntime(): PluginRuntime {
  return pluginRuntime
}

export function getBuiltinPluginIds(): string[] {
  return [...definitions.keys()].sort()
}

export function getBuiltinPluginCriticality(
  pluginId: string,
): BuiltinPluginDefinition['criticality'] | undefined {
  return definitions.get(pluginId)?.criticality
}

export type BuiltinBootstrapMode = 'normal' | 'safe-mode'

export async function bootstrapBuiltins(mode: BuiltinBootstrapMode): Promise<BuiltinPluginBootstrapResult> {
  if (mode === 'safe-mode') {
    for (const identity of [...pluginRuntime.snapshot().active].reverse()) {
      if (!definitions.has(identity.pluginId)) await pluginRuntime.deactivate(identity.key)
    }
  }
  return bootstrapPluginDefinitions(pluginRuntime, [...definitions.values()], mode)
}

export async function retryBuiltinPlugin(pluginId: string): Promise<BuiltinPluginBootstrapResult> {
  if (!definitions.has(pluginId)) throw new Error(`未知内置插件：${pluginId}`)
  const closure = new Set<string>()
  const include = (id: string) => {
    if (closure.has(id)) return
    const definition = definitions.get(id)
    if (!definition) throw new Error(`内置插件依赖不存在：${id}`)
    for (const dependency of Object.keys(definition.dependencies ?? {})) include(dependency)
    closure.add(id)
  }
  include(pluginId)
  const result = await bootstrapPluginDefinitions(
    pluginRuntime,
    [...definitions.values()].filter(definition => closure.has(definition.id)),
    'normal',
  )
  const activePluginIds = pluginRuntime.snapshot().active.map(item => item.pluginId).sort()
  const active = new Set(activePluginIds)
  return Object.freeze({
    activePluginIds: Object.freeze(activePluginIds),
    failures: result.failures,
    skippedPluginIds: Object.freeze(getBuiltinPluginIds().filter(id => !active.has(id))),
  })
}

export async function activateBuiltinPlugin(pluginId: string): Promise<void> {
  const definition = definitions.get(pluginId)
  if (!definition) throw new Error(`未知内置插件：${pluginId}`)
  if (pluginRuntime.snapshot().active.some(identity => identity.pluginId === pluginId)) return
  if (definition.version && definition.packageInstanceId) await pluginRuntime.activatePackage(definition)
  else await pluginRuntime.activateBuiltin(definition)
}

let pluginPackageClient: PluginPackageClient | undefined
let packagePluginRuntimeService: PackagePluginRuntimeService | undefined
let packageInstallationService: PackageInstallationService | undefined

export function getPluginPackageClient(): PluginPackageClient {
  if (!pluginPackageClient) {
    pluginPackageClient = createPluginPackageClient({
      transport: {
        invoke: (cmd: string, args?: unknown) => invoke(cmd, args as Record<string, unknown> | undefined),
      },
    })
  }
  return pluginPackageClient
}

export function getPackagePluginRuntimeService(): PackagePluginRuntimeService {
  if (!packagePluginRuntimeService) {
    packagePluginRuntimeService = new PackagePluginRuntimeService({
      runtime: pluginRuntime,
      packages: getPluginPackageClient(),
    })
  }
  return packagePluginRuntimeService
}

export function getPackageInstallationService(): PackageInstallationService {
  if (!packageInstallationService) {
    packageInstallationService = new PackageInstallationService({
      runtime: pluginRuntime,
      packageRuntime: getPackagePluginRuntimeService(),
      packages: getPluginPackageClient(),
    })
  }
  return packageInstallationService
}

export function getPluginProcessClient(): PluginProcessClient {
  return getRuntimePluginProcessClient()
}

if (typeof window !== 'undefined'
  && shouldExposeKernelAcceptanceControls(import.meta.env.DEV, window.localStorage)) {
  window.__PYLON_PACKAGE_RUNTIME_DEV__ = {
    activateFromDirectory: (sourcePath, expectedId) =>
      getPackagePluginRuntimeService().activateFromDirectory(sourcePath, expectedId),
    updateFromDirectory: (sourcePath, expectedId) =>
      getPackagePluginRuntimeService().updateFromDirectory(sourcePath, expectedId),
    executeCommand: commandId => runtimeServices.commandRegistry.execute(commandId),
    deactivate: runtimeInstanceId => pluginRuntime.deactivate(runtimeInstanceId),
    snapshot: () => pluginRuntime.snapshot(),
  }
}

declare global {
  interface Window {
    __PYLON_PACKAGE_RUNTIME_DEV__?: {
      activateFromDirectory: PackagePluginRuntimeService['activateFromDirectory']
      updateFromDirectory: PackagePluginRuntimeService['updateFromDirectory']
      executeCommand: (commandId: string) => Promise<unknown>
      deactivate: PluginRuntime['deactivate']
      snapshot: PluginRuntime['snapshot']
    }
  }
}
