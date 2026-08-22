import { CommandRegistry } from './commands/commandRegistry.ts'
import { PluginEventBus } from './events/pluginEventBus.ts'
import { HookRuntime } from './hooks/hookRuntime.ts'
import { RegistryHub } from './registry/registryHub.ts'
import { RendererRegistry } from './renderers/rendererRegistry.ts'
import { createRendererSettingsStore, type RendererSettingsStore } from './renderers/rendererSettingsStore.ts'
import { PluginUiRegistry } from './ui/pluginUiRegistry.ts'
import { PluginServiceRegistry } from './services/pluginServiceRegistry.ts'
import { AgentSidebarRegistry } from './sidebar/sidebarRegistry.ts'
import { FileWorkbenchRegistry } from './file-workbench/fileWorkbenchRegistry.ts'
import { ContextPanelRegistry } from './context-panel/contextPanelRegistry.ts'
import { PresentationProfileRegistry } from './presentation/presentationProfileRegistry.ts'
import { PluginSettingsPageRegistry } from './settings/pluginSettingsRegistry.ts'
import { PluginSettingsStore } from './settings/pluginSettingsStore.ts'
import { PluginSettingOptionsRegistry } from './settings/pluginSettingOptionsRegistry.ts'
import { FontContributionRegistry } from './fonts/fontContributionRegistry.ts'
import { SessionCreationRegistry } from './session-creation/sessionCreationRegistry.ts'
import { InterfaceModeRegistry } from './interface-mode/interfaceModeRegistry.ts'
import {
  getWorkspaceRegistryStore,
  WorkspaceRegistryStore,
} from '../workspace-sheets/workspaceRegistry.ts'
import type { RuntimeRegistries } from './pluginHostServices.ts'

export interface RuntimeServices extends RuntimeRegistries {
  readonly hookRuntime: HookRuntime
  readonly rendererSettingsStore: RendererSettingsStore
}

export interface CreateRuntimeServicesOptions {
  hookRuntime?: HookRuntime
  workspaceRegistry?: WorkspaceRegistryStore
  rendererSettingsStore?: RendererSettingsStore
}

export function createRuntimeServices(options: CreateRuntimeServicesOptions = {}): RuntimeServices {
  return Object.freeze({
    registryHub: new RegistryHub(),
    commandRegistry: new CommandRegistry(),
    eventBus: new PluginEventBus(),
    hookRuntime: options.hookRuntime ?? new HookRuntime(),
    rendererRegistry: new RendererRegistry(),
    rendererSettingsStore: options.rendererSettingsStore ?? createRendererSettingsStore({
      storage: typeof localStorage === 'undefined' ? undefined : localStorage,
    }),
    pluginUiRegistry: new PluginUiRegistry(),
    pluginServiceRegistry: new PluginServiceRegistry(),
    agentSidebarRegistry: new AgentSidebarRegistry(),
    fileWorkbenchRegistry: new FileWorkbenchRegistry(),
    contextPanelRegistry: new ContextPanelRegistry(),
    presentationProfileRegistry: new PresentationProfileRegistry(),
    pluginSettingsPageRegistry: new PluginSettingsPageRegistry(),
    pluginSettingsStore: new PluginSettingsStore(),
    pluginSettingOptionsRegistry: new PluginSettingOptionsRegistry(),
    fontContributionRegistry: new FontContributionRegistry(),
    sessionCreationRegistry: new SessionCreationRegistry(),
    interfaceModeRegistry: new InterfaceModeRegistry(),
    workspaceRegistry: options.workspaceRegistry ?? new WorkspaceRegistryStore(),
  })
}

type PluginDisableHandler = (pluginId: string) => void | Promise<void>

let pluginDisableHandler: PluginDisableHandler | undefined
const runtimeServices = createRuntimeServices({
  workspaceRegistry: getWorkspaceRegistryStore(),
  hookRuntime: new HookRuntime(undefined, {
    onDisablePlugin: pluginId => {
      if (!pluginDisableHandler) throw new Error('Plugin Runtime disable handler is not bound')
      return pluginDisableHandler(pluginId)
    },
  }),
})

/** Composition-root seam: binds hook failure isolation to the single product runtime. */
export function bindPluginDisableHandler(handler: PluginDisableHandler): void {
  pluginDisableHandler = handler
}

export function getRuntimeServices(): RuntimeServices {
  return runtimeServices
}

export function getRegistryHub(): RegistryHub {
  return runtimeServices.registryHub
}

export function getCommandRegistry(): CommandRegistry {
  return runtimeServices.commandRegistry
}

export function getPluginEventBus(): PluginEventBus {
  return runtimeServices.eventBus
}

export function getHookRuntime(): HookRuntime {
  return runtimeServices.hookRuntime
}

export function getRendererRegistry(): RendererRegistry {
  return runtimeServices.rendererRegistry
}

export function getRendererSettingsStore(): RendererSettingsStore {
  return runtimeServices.rendererSettingsStore
}

export function getPluginUiRegistry(): PluginUiRegistry {
  return runtimeServices.pluginUiRegistry
}

export function getPluginServiceRegistry(): PluginServiceRegistry {
  return runtimeServices.pluginServiceRegistry
}

export function getAgentSidebarRegistry(): AgentSidebarRegistry {
  return runtimeServices.agentSidebarRegistry
}

export function getFileWorkbenchRegistry(): FileWorkbenchRegistry { return runtimeServices.fileWorkbenchRegistry }

export function getContextPanelRegistry(): ContextPanelRegistry { return runtimeServices.contextPanelRegistry }

export function getPresentationProfileRegistry(): PresentationProfileRegistry { return runtimeServices.presentationProfileRegistry }
export function getPluginSettingsPageRegistry(): PluginSettingsPageRegistry { return runtimeServices.pluginSettingsPageRegistry }
export function getPluginSettingsStore(): PluginSettingsStore { return runtimeServices.pluginSettingsStore }
export function getPluginSettingOptionsRegistry(): PluginSettingOptionsRegistry { return runtimeServices.pluginSettingOptionsRegistry }
export function getFontContributionRegistry(): FontContributionRegistry { return runtimeServices.fontContributionRegistry }
export function getSessionCreationRegistry(): SessionCreationRegistry { return runtimeServices.sessionCreationRegistry }
export function getInterfaceModeRegistry(): InterfaceModeRegistry { return runtimeServices.interfaceModeRegistry }
