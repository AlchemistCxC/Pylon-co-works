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
import { createPluginTitlebarApi, type PluginTitlebarApi } from './titlebar/pluginTitlebarApi.ts'
import type { TitlebarContribution } from './titlebar/titlebarTypes.ts'
import { createPluginStorageApi } from './storage/pluginStorageApi.ts'
import type { PluginStorageApi } from './storage/pluginStorageTypes.ts'
import type { PluginManagementApi } from './management/pluginManagementTypes.ts'
import type { BuiltinPluginDefinition } from './pluginRuntime.ts'

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
  readonly titlebar: RegistryTransaction<TitlebarContribution>
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
  readonly titlebar: PluginTitlebarApi
  /** API 1.1 新增：插件私有 KV 存储（按 pluginId 隔离，超软配额抛错） */
  readonly storage: PluginStorageApi
  /** API 1.2 新增：capability-gated 管理面。仅当 manifest 声明 `plugin.management`
   *  且用户已授权时存在；未声明或未授权时属性不存在（C3：条件装配，不是空实现）。 */
  readonly management?: PluginManagementApi
}

export interface PluginActivationContextOptions {
  readonly definition?: BuiltinPluginDefinition
  readonly createManagementApi?: (
    definition: BuiltinPluginDefinition,
    scope: PluginScope,
  ) => PluginManagementApi | undefined
}

export type PluginActivationContextFactory = (
  identity: PluginIdentity,
  scope: PluginScope,
  transactions?: PluginActivationTransactions,
  definition?: BuiltinPluginDefinition,
) => BuiltinPluginActivationContext

export function createPluginActivationContext(
  host: PluginHostServices,
  identity: PluginIdentity,
  scope: PluginScope,
  transactions?: PluginActivationTransactions,
  options: PluginActivationContextOptions = {},
): BuiltinPluginActivationContext {
  const dataApis = createPluginSessionDataApis(identity)
  const { registries } = host
  // C3 门控：management 属性存在 ⇔ 声明 ∧ 授权（createManagementApi 由宿主
  // 注入 grant 检查；未声明/未授权返回 undefined → 属性不装配）
  const management = options.definition && options.createManagementApi
    ? options.createManagementApi(options.definition, scope)
    : undefined
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
    titlebar: createPluginTitlebarApi(
      registries.titlebarRegistry,
      identity,
      scope,
      transactions?.titlebar,
    ),
    storage: createPluginStorageApi(identity),
    ...(management ? { management } : {}),
  }
}
