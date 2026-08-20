import { createPluginSessionDataApis, type PluginSessionsApi, type PluginTurnsApi } from './sessionData/pluginSessionDataApi.ts'
import { createPluginProcessApi } from './process/pluginProcessApi.ts'
import type { PluginProcessApi } from './process/processTypes.ts'
import { createPluginWorkspaceApi, type PluginWorkspaceApi } from './workspaces/pluginWorkspaceApi.ts'
import { createPluginRendererApi, type RendererApi } from './renderers/pluginRendererApi.ts'
import { createPluginCommandApi, type PluginCommandApi } from './commands/pluginCommandApi.ts'
import { createPluginHookApi, type PluginHookApi } from './hooks/pluginHookApi.ts'
import type { CommandRegistryTransaction } from './commands/commandRegistry.ts'
import type { HookRegistryTransaction } from './hooks/hookRegistry.ts'
import type { RendererRegistryTransaction } from './renderers/rendererRegistry.ts'
import type { WorkspaceRegistryTransaction } from '../workspace-sheets/workspaceRegistry.ts'
import type { PluginApplicationRegistryTransaction } from './application/applicationHost.ts'
import type { PluginIdentity } from './pluginIdentity.ts'
import type { PluginScope } from './pluginScope.ts'
import type { PluginHostServices } from './pluginHostServices.ts'
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
  readonly application: PluginApplicationRegistryTransaction
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

export type PluginActivationContextFactory = (
  identity: PluginIdentity,
  scope: PluginScope,
  transactions?: PluginActivationTransactions,
) => BuiltinPluginActivationContext

export function createPluginActivationContext(
  host: PluginHostServices,
  identity: PluginIdentity,
  scope: PluginScope,
  transactions?: PluginActivationTransactions,
): BuiltinPluginActivationContext {
  const dataApis = createPluginSessionDataApis(identity)
  const { registries } = host
  return {
    identity,
    scope,
    application: createPluginApplicationApi(host.application, identity, scope, transactions?.application),
    workspace: createPluginWorkspaceApi(registries.workspaceRegistry, identity, scope, transactions?.workspace),
    renderer: createPluginRendererApi(registries.rendererRegistry, identity, scope, transactions?.renderer),
    commands: createPluginCommandApi(registries.commandRegistry, identity, scope, transactions?.commands),
    hooks: createPluginHookApi(host.hooks, identity, scope, transactions?.hooks),
    sessions: dataApis.sessions,
    turns: dataApis.turns,
    process: createPluginProcessApi(identity, scope, host.processClient),
    ui: createPluginUiApi(registries.pluginUiRegistry, identity, scope, transactions?.ui),
    services: createPluginServiceApi(registries.pluginServiceRegistry, identity, scope, transactions?.services),
    sidebar: createPluginSidebarApi(registries.agentSidebarRegistry, identity, scope, transactions?.sidebar),
    fileWorkbench: createPluginFileWorkbenchApi(registries.fileWorkbenchRegistry, identity, scope, transactions?.fileWorkbench),
    contextPanel: createPluginContextPanelApi(registries.contextPanelRegistry, identity, scope, transactions?.contextPanel),
    presentation: createPluginPresentationApi(registries.presentationProfileRegistry, identity, scope, transactions?.presentation),
    settings: createPluginSettingsApi(
      registries.pluginSettingsPageRegistry,
      registries.pluginSettingsStore,
      identity,
      scope,
      transactions?.settings,
      registries.pluginSettingOptionsRegistry,
      transactions?.settingOptions,
    ),
    fonts: createPluginFontApi(registries.fontContributionRegistry, identity, scope, transactions?.fonts),
    sessionCreation: createPluginSessionCreationApi(
      registries.sessionCreationRegistry,
      identity,
      scope,
      transactions?.sessionCreation,
    ),
    interfaceModes: createPluginInterfaceModeApi(
      registries.interfaceModeRegistry,
      identity,
      scope,
      transactions?.interfaceModes,
    ),
  }
}
