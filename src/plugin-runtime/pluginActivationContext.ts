import { createPluginSessionDataApis, type PluginSessionsApi, type PluginTurnsApi } from './sessionData/pluginSessionDataApi.ts'
import { createPluginProcessApi } from './process/pluginProcessApi.ts'
import { getPluginProcessClient } from './process/processRuntimeServices.ts'
import type { PluginProcessApi } from './process/processTypes.ts'
import { createPluginWorkspaceApi, type PluginWorkspaceApi } from './workspaces/pluginWorkspaceApi.ts'
import { createPluginRendererApi, type RendererApi } from './renderers/pluginRendererApi.ts'
import { createPluginCommandApi, type PluginCommandApi } from './commands/pluginCommandApi.ts'
import { createPluginHookApi, type PluginHookApi } from './hooks/pluginHookApi.ts'
import type { CommandRegistryTransaction } from './commands/commandRegistry.ts'
import type { HookRegistryTransaction } from './hooks/hookRegistry.ts'
import type { RendererRegistryTransaction } from './renderers/rendererRegistry.ts'
import type { WorkspaceRegistryTransaction } from '../workspace-sheets/workspaceRegistry.ts'
import type { ApplicationRegistryTransaction } from '../kernel/applicationRuntime.ts'
import type { PluginIdentity } from './pluginIdentity.ts'
import type { PluginScope } from './pluginScope.ts'
import { getAgentSidebarRegistry, getCommandRegistry, getContextPanelRegistry, getFileWorkbenchRegistry, getFontContributionRegistry, getHookRuntime, getInterfaceModeRegistry, getPluginServiceRegistry, getPluginSettingOptionsRegistry, getPluginSettingsPageRegistry, getPluginSettingsStore, getPluginUiRegistry, getPresentationProfileRegistry, getRendererRegistry, getSessionCreationRegistry } from './runtimeServices.ts'
import { applicationRuntime } from '../kernel/applicationRuntimeServices.ts'
import {
  createPluginApplicationApi,
  type PluginApplicationApi,
} from './application/pluginApplicationApi.ts'
import { createPluginUiApi, type PluginUiApi } from './ui/pluginUiApi.ts'
import type { PluginUiSurface } from './ui/pluginUiTypes.ts'
import type { RegistryTransaction } from './registry/types.ts'
import { createPluginServiceApi, type PluginServiceApi } from './services/pluginServiceApi.ts'
import type { PluginServiceContribution } from './services/pluginServiceRegistry.ts'
import { createPluginSidebarApi, type PluginSidebarApi } from './sidebar/pluginSidebarApi.ts'
import type { AgentSidebarContribution } from './sidebar/sidebarTypes.ts'
import { createPluginFileWorkbenchApi, type PluginFileWorkbenchApi } from './file-workbench/pluginFileWorkbenchApi.ts'
import type { FileWorkbenchContribution } from './file-workbench/fileWorkbenchTypes.ts'
import { createPluginContextPanelApi, type PluginContextPanelApi } from './context-panel/pluginContextPanelApi.ts'
import type { ContextPanelContribution } from './context-panel/contextPanelTypes.ts'
import { createPluginPresentationApi, type PluginPresentationApi } from './presentation/pluginPresentationApi.ts'
import type { PresentationProfileContribution } from './presentation/presentationProfileTypes.ts'
import { createPluginSettingsApi, type PluginSettingsApi } from './settings/pluginSettingsApi.ts'
import type { PluginSettingsPageContribution } from './settings/pluginSettingsTypes.ts'
import type { PluginSettingOptionsContribution } from './settings/pluginSettingsTypes.ts'
import { createPluginFontApi, type PluginFontApi } from './fonts/pluginFontApi.ts'
import type { FontContribution } from './fonts/fontContributionTypes.ts'
import { createPluginSessionCreationApi, type PluginSessionCreationApi } from './session-creation/pluginSessionCreationApi.ts'
import type { SessionCreationRegistryTransaction } from './session-creation/sessionCreationRegistry.ts'
import { createPluginInterfaceModeApi, type PluginInterfaceModeApi } from './interface-mode/pluginInterfaceModeApi.ts'
import type { InterfaceModeContribution } from './interface-mode/interfaceModeTypes.ts'

export interface PluginActivationTransactions {
  readonly application: ApplicationRegistryTransaction
  readonly commands: CommandRegistryTransaction
  readonly hooks: HookRegistryTransaction
  readonly renderer: RendererRegistryTransaction
  readonly workspace: WorkspaceRegistryTransaction
  readonly ui: RegistryTransaction<PluginUiSurface>
  readonly services: RegistryTransaction<PluginServiceContribution>
  readonly sidebar: RegistryTransaction<AgentSidebarContribution>
  readonly fileWorkbench: RegistryTransaction<FileWorkbenchContribution>
  readonly contextPanel: RegistryTransaction<ContextPanelContribution>
  readonly presentation: RegistryTransaction<PresentationProfileContribution>
  readonly settings: RegistryTransaction<PluginSettingsPageContribution>
  readonly settingOptions: RegistryTransaction<PluginSettingOptionsContribution>
  readonly fonts: RegistryTransaction<FontContribution>
  readonly sessionCreation: SessionCreationRegistryTransaction
  readonly interfaceModes: RegistryTransaction<InterfaceModeContribution>
}

export interface BuiltinPluginActivationContext {
  readonly identity: PluginIdentity
  readonly scope: PluginScope
  readonly application: PluginApplicationApi
  readonly workspace: PluginWorkspaceApi
  readonly renderer: RendererApi
  readonly commands: PluginCommandApi
  readonly hooks: PluginHookApi
  readonly sessions: PluginSessionsApi
  readonly turns: PluginTurnsApi
  readonly process: PluginProcessApi
  readonly ui: PluginUiApi
  readonly services: PluginServiceApi
  readonly sidebar: PluginSidebarApi
  readonly fileWorkbench: PluginFileWorkbenchApi
  readonly contextPanel: PluginContextPanelApi
  readonly presentation: PluginPresentationApi
  readonly settings: PluginSettingsApi
  readonly fonts: PluginFontApi
  readonly sessionCreation: PluginSessionCreationApi
  readonly interfaceModes: PluginInterfaceModeApi
}

export function createPluginActivationContext(
  identity: PluginIdentity,
  scope: PluginScope,
  transactions?: PluginActivationTransactions,
): BuiltinPluginActivationContext {
  const dataApis = createPluginSessionDataApis(identity)
  return {
    identity,
    scope,
    application: createPluginApplicationApi(applicationRuntime, identity, scope, transactions?.application),
    workspace: createPluginWorkspaceApi(identity, scope, transactions?.workspace),
    renderer: createPluginRendererApi(getRendererRegistry(), identity, scope, transactions?.renderer),
    commands: createPluginCommandApi(getCommandRegistry(), identity, scope, transactions?.commands),
    hooks: createPluginHookApi(getHookRuntime(), identity, scope, transactions?.hooks),
    sessions: dataApis.sessions,
    turns: dataApis.turns,
    process: createPluginProcessApi(identity, scope, getPluginProcessClient()),
    ui: createPluginUiApi(getPluginUiRegistry(), identity, scope, transactions?.ui),
    services: createPluginServiceApi(getPluginServiceRegistry(), identity, scope, transactions?.services),
    sidebar: createPluginSidebarApi(getAgentSidebarRegistry(), identity, scope, transactions?.sidebar),
    fileWorkbench: createPluginFileWorkbenchApi(getFileWorkbenchRegistry(), identity, scope, transactions?.fileWorkbench),
    contextPanel: createPluginContextPanelApi(getContextPanelRegistry(), identity, scope, transactions?.contextPanel),
    presentation: createPluginPresentationApi(getPresentationProfileRegistry(), identity, scope, transactions?.presentation),
    settings: createPluginSettingsApi(
      getPluginSettingsPageRegistry(),
      getPluginSettingsStore(),
      identity,
      scope,
      transactions?.settings,
      getPluginSettingOptionsRegistry(),
      transactions?.settingOptions,
    ),
    fonts: createPluginFontApi(getFontContributionRegistry(), identity, scope, transactions?.fonts),
    sessionCreation: createPluginSessionCreationApi(
      getSessionCreationRegistry(),
      identity,
      scope,
      transactions?.sessionCreation,
    ),
    interfaceModes: createPluginInterfaceModeApi(
      getInterfaceModeRegistry(),
      identity,
      scope,
      transactions?.interfaceModes,
    ),
  }
}
