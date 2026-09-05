import { type PluginSessionsApi, type PluginTurnsApi } from './sessionData/pluginSessionDataApi.js';
import type { PluginProcessApi } from './process/processTypes.js';
import { type PluginWorkspaceApi } from './workspaces/pluginWorkspaceApi.js';
import { type RendererApi } from './renderers/pluginRendererApi.js';
import { type PluginCommandApi } from './commands/pluginCommandApi.js';
import { type PluginHookApi } from './hooks/pluginHookApi.js';
import type { CommandRegistryTransaction } from './commands/commandRegistry.js';
import type { HookRegistryTransaction } from './hooks/hookRegistry.js';
import type { RendererRegistryTransaction } from './renderers/rendererRegistry.js';
import type { WorkspaceRegistryTransaction } from '../workspace-sheets/workspaceRegistry.js';
import type { PluginApplicationRegistryTransaction } from './application/applicationHost.js';
import type { PluginIdentity } from './pluginIdentity.js';
import type { PluginScope } from './pluginScope.js';
import type { PluginHostServices } from './pluginHostServices.js';
import { type PluginApplicationApi } from './application/pluginApplicationApi.js';
import { type PluginUiApi } from './ui/pluginUiApi.js';
import type { PluginUiSurface } from './ui/pluginUiTypes.js';
import type { RegistryTransaction } from './registry/types.js';
import { type PluginServiceApi } from './services/pluginServiceApi.js';
import type { PluginServiceContribution } from './services/pluginServiceRegistry.js';
import { type PluginSidebarApi } from './sidebar/pluginSidebarApi.js';
import type { AgentSidebarContribution } from './sidebar/sidebarTypes.js';
import { type PluginFileWorkbenchApi } from './file-workbench/pluginFileWorkbenchApi.js';
import type { FileWorkbenchContribution } from './file-workbench/fileWorkbenchTypes.js';
import { type PluginContextPanelApi } from './context-panel/pluginContextPanelApi.js';
import type { ContextPanelContribution } from './context-panel/contextPanelTypes.js';
import { type PluginPresentationApi } from './presentation/pluginPresentationApi.js';
import type { PresentationProfileContribution } from './presentation/presentationProfileTypes.js';
import { type PluginSettingsApi } from './settings/pluginSettingsApi.js';
import type { PluginSettingsPageContribution } from './settings/pluginSettingsTypes.js';
import type { PluginSettingOptionsContribution } from './settings/pluginSettingsTypes.js';
import { type PluginFontApi } from './fonts/pluginFontApi.js';
import type { FontContribution } from './fonts/fontContributionTypes.js';
import { type PluginSessionCreationApi } from './session-creation/pluginSessionCreationApi.js';
import type { SessionCreationRegistryTransaction } from './session-creation/sessionCreationRegistry.js';
import { type PluginInterfaceModeApi } from './interface-mode/pluginInterfaceModeApi.js';
import type { InterfaceModeContribution } from './interface-mode/interfaceModeTypes.js';
import { type PluginTitlebarApi } from './titlebar/pluginTitlebarApi.js';
import type { TitlebarContribution } from './titlebar/titlebarTypes.js';
import type { PluginStorageApi } from './storage/pluginStorageTypes.js';
import type { PluginManagementApi } from './management/pluginManagementTypes.js';
import type { BuiltinPluginDefinition } from './pluginRuntime.js';
export interface PluginActivationTransactions {
    readonly application: PluginApplicationRegistryTransaction;
    readonly commands: CommandRegistryTransaction;
    readonly hooks: HookRegistryTransaction;
    readonly renderer: RendererRegistryTransaction;
    readonly workspace: WorkspaceRegistryTransaction;
    readonly ui: RegistryTransaction<PluginUiSurface>;
    readonly services: RegistryTransaction<PluginServiceContribution>;
    readonly sidebar: RegistryTransaction<AgentSidebarContribution>;
    readonly fileWorkbench: RegistryTransaction<FileWorkbenchContribution>;
    readonly contextPanel: RegistryTransaction<ContextPanelContribution>;
    readonly presentation: RegistryTransaction<PresentationProfileContribution>;
    readonly settings: RegistryTransaction<PluginSettingsPageContribution>;
    readonly settingOptions: RegistryTransaction<PluginSettingOptionsContribution>;
    readonly fonts: RegistryTransaction<FontContribution>;
    readonly sessionCreation: SessionCreationRegistryTransaction;
    readonly interfaceModes: RegistryTransaction<InterfaceModeContribution>;
    readonly titlebar: RegistryTransaction<TitlebarContribution>;
}
export interface BuiltinPluginActivationContext {
    readonly identity: PluginIdentity;
    readonly scope: PluginScope;
    readonly application: PluginApplicationApi;
    readonly workspace: PluginWorkspaceApi;
    readonly renderer: RendererApi;
    readonly commands: PluginCommandApi;
    readonly hooks: PluginHookApi;
    readonly sessions: PluginSessionsApi;
    readonly turns: PluginTurnsApi;
    readonly process: PluginProcessApi;
    readonly ui: PluginUiApi;
    readonly services: PluginServiceApi;
    readonly sidebar: PluginSidebarApi;
    readonly fileWorkbench: PluginFileWorkbenchApi;
    readonly contextPanel: PluginContextPanelApi;
    readonly presentation: PluginPresentationApi;
    readonly settings: PluginSettingsApi;
    readonly fonts: PluginFontApi;
    readonly sessionCreation: PluginSessionCreationApi;
    readonly interfaceModes: PluginInterfaceModeApi;
    readonly titlebar: PluginTitlebarApi;
    /** API 1.1 新增：插件私有 KV 存储（按 pluginId 隔离，超软配额抛错） */
    readonly storage: PluginStorageApi;
    /** API 1.2 新增：capability-gated 管理面。仅当 manifest 声明 `plugin.management`
     *  且用户已授权时存在；未声明或未授权时属性不存在（C3：条件装配，不是空实现）。 */
    readonly management?: PluginManagementApi;
}
export interface PluginActivationContextOptions {
    readonly definition?: BuiltinPluginDefinition;
    readonly createManagementApi?: (definition: BuiltinPluginDefinition, scope: PluginScope) => PluginManagementApi | undefined;
}
export type PluginActivationContextFactory = (identity: PluginIdentity, scope: PluginScope, transactions?: PluginActivationTransactions, definition?: BuiltinPluginDefinition) => BuiltinPluginActivationContext;
export declare function createPluginActivationContext(host: PluginHostServices, identity: PluginIdentity, scope: PluginScope, transactions?: PluginActivationTransactions, options?: PluginActivationContextOptions): BuiltinPluginActivationContext;
