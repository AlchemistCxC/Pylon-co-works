/** API 1.0 plugin composition root: the only product runtime and package owner. */
import { invoke } from '@tauri-apps/api/core'
import { requestApplicationSoftRemount } from '../kernel/applicationRuntimeServices.ts'
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
import { getCommandRegistry } from './runtimeServices.ts'
import { BUILTIN_SKIN_PLUGIN_ID, createBuiltinSkinPluginDefinition } from './skin/builtinSkinPlugin.ts'

const pluginRuntime = new PluginRuntime({ requestSoftRemount: requestApplicationSoftRemount })
const definitions = new Map<string, BuiltinPluginDefinition>()

for (const definition of createBuiltinProductPluginDefinitions()) definitions.set(definition.id, definition)
definitions.set(
  BUILTIN_SKIN_PLUGIN_ID,
  createBuiltinSkinPluginDefinition(getSkinRuntime(), createSkinHostPorts(getSkinRuntime())),
)
for (const definition of definitions.values()) pluginRuntime.activateBuiltinSync(definition)

export function getPluginRuntime(): PluginRuntime {
  return pluginRuntime
}

export function getBuiltinPluginIds(): string[] {
  return [...definitions.keys()].sort()
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
    executeCommand: commandId => getCommandRegistry().execute(commandId),
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
