import { CommandRegistry } from './commands/commandRegistry.ts'
import { PluginEventBus } from './events/pluginEventBus.ts'
import { HookRuntime } from './hooks/hookRuntime.ts'
import { RegistryHub } from './registry/registryHub.ts'
import { RendererRegistry } from './renderers/rendererRegistry.ts'
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

const registryHub = new RegistryHub()
const commandRegistry = new CommandRegistry()
const eventBus = new PluginEventBus()
const hookRuntime = new HookRuntime()
const rendererRegistry = new RendererRegistry()
const pluginUiRegistry = new PluginUiRegistry()
const pluginServiceRegistry = new PluginServiceRegistry()
const agentSidebarRegistry = new AgentSidebarRegistry()
const fileWorkbenchRegistry = new FileWorkbenchRegistry()
const contextPanelRegistry = new ContextPanelRegistry()
const presentationProfileRegistry = new PresentationProfileRegistry()
const pluginSettingsPageRegistry = new PluginSettingsPageRegistry()
const pluginSettingsStore = new PluginSettingsStore()
const pluginSettingOptionsRegistry = new PluginSettingOptionsRegistry()
const fontContributionRegistry = new FontContributionRegistry()
const sessionCreationRegistry = new SessionCreationRegistry()
const interfaceModeRegistry = new InterfaceModeRegistry()

export function getRegistryHub(): RegistryHub {
  return registryHub
}

export function getCommandRegistry(): CommandRegistry {
  return commandRegistry
}

export function getPluginEventBus(): PluginEventBus {
  return eventBus
}

export function getHookRuntime(): HookRuntime {
  return hookRuntime
}

export function getRendererRegistry(): RendererRegistry {
  return rendererRegistry
}

export function getPluginUiRegistry(): PluginUiRegistry {
  return pluginUiRegistry
}

export function getPluginServiceRegistry(): PluginServiceRegistry {
  return pluginServiceRegistry
}

export function getAgentSidebarRegistry(): AgentSidebarRegistry {
  return agentSidebarRegistry
}

export function getFileWorkbenchRegistry(): FileWorkbenchRegistry { return fileWorkbenchRegistry }

export function getContextPanelRegistry(): ContextPanelRegistry { return contextPanelRegistry }

export function getPresentationProfileRegistry(): PresentationProfileRegistry { return presentationProfileRegistry }
export function getPluginSettingsPageRegistry(): PluginSettingsPageRegistry { return pluginSettingsPageRegistry }
export function getPluginSettingsStore(): PluginSettingsStore { return pluginSettingsStore }
export function getPluginSettingOptionsRegistry(): PluginSettingOptionsRegistry { return pluginSettingOptionsRegistry }
export function getFontContributionRegistry(): FontContributionRegistry { return fontContributionRegistry }
export function getSessionCreationRegistry(): SessionCreationRegistry { return sessionCreationRegistry }
export function getInterfaceModeRegistry(): InterfaceModeRegistry { return interfaceModeRegistry }
