/**
 * Pylon API 1.0 插件开发 SDK（public authoring surface）。
 *
 * 打包约束：本文件会被 esbuild 打进插件 bundle ——
 * - `export type` 全部为编译期类型，零运行时代价；
 * - 运行时值仅限常量表与纯函数 helpers，禁止 import 任何宿主运行时模块；
 * - helpers 的 DOM 输出一律使用宿主视觉语义 token（VISUAL_SEMANTIC_TOKENS），
 *   不复制宿主的透明度/阴影/动画毫秒值。
 */
import { PYLON_PLUGIN_API_MIN, PYLON_PLUGIN_API_LATEST, PYLON_PLUGIN_API_SUPPORTED, PYLON_PLUGIN_API_VERSION, PYLON_PLUGIN_CAPABILITIES, PYLON_PLUGIN_MANIFEST_FILE, type PylonPluginManifest } from '../plugin-runtime/packageManifest.js';
import type { PackagePluginModule } from '../plugin-runtime/packagePluginRuntime.js';
import type { PluginUiSurface } from '../plugin-runtime/ui/pluginUiTypes.js';
export type { BuiltinPluginActivationContext as PluginActivationContext } from '../plugin-runtime/pluginActivationContext.js';
export type { PackagePluginModule } from '../plugin-runtime/packagePluginRuntime.js';
export type { PylonPluginManifest } from '../plugin-runtime/packageManifest.js';
export type { PluginIdentity } from '../plugin-runtime/pluginIdentity.js';
export type { PluginScope, PluginResourceDisposable, PluginResourceMetadata, PluginCleanupError, PluginScopeDisposeResult, } from '../plugin-runtime/pluginScope.js';
export type { CommandDefinition, CommandExecutionContext, CommandDescriptor, CommandFilter, CommandRegisterOptions, } from '../plugin-runtime/commands/commandRegistry.js';
export type { PluginCommandApi as CommandApi } from '../plugin-runtime/commands/pluginCommandApi.js';
export type { PluginApplicationApi } from '../plugin-runtime/application/pluginApplicationApi.js';
export type { PluginWorkspaceApi } from '../plugin-runtime/workspaces/pluginWorkspaceApi.js';
export type { PluginServiceApi } from '../plugin-runtime/services/pluginServiceApi.js';
export type { PluginSidebarApi } from '../plugin-runtime/sidebar/pluginSidebarApi.js';
export type { PluginFileWorkbenchApi } from '../plugin-runtime/file-workbench/pluginFileWorkbenchApi.js';
export type { PluginContextPanelApi } from '../plugin-runtime/context-panel/pluginContextPanelApi.js';
export type { PluginFontApi } from '../plugin-runtime/fonts/pluginFontApi.js';
export type { PluginSessionCreationApi } from '../plugin-runtime/session-creation/pluginSessionCreationApi.js';
export type { PluginInterfaceModeApi } from '../plugin-runtime/interface-mode/pluginInterfaceModeApi.js';
export type { PluginTitlebarApi } from '../plugin-runtime/titlebar/pluginTitlebarApi.js';
export type { PluginStorageApi } from '../plugin-runtime/storage/pluginStorageTypes.js';
/** API 1.2 capability-gated 管理面：仅当 manifest 声明 `plugin.management`
 *  且用户对该版本授权后，activation context 才装配 `management` 属性。 */
export type { PluginManagementApi } from '../plugin-runtime/management/pluginManagementTypes.js';
export type { PluginManagementErrorCode, PluginRuntimeOverview, PluginRuntimeOverviewEntry, PluginBootstrapOverview, PluginBootstrapOverviewEntry, PluginContractDiagnostics, PluginCapabilityGrantFact, } from '../plugin-runtime/management/pluginManagementTypes.js';
export type { PylonPluginCapability } from '../plugin-runtime/packageManifest.js';
export type { HookName, HookMode, HookExecution, HookFailurePolicy, HookInvocationContext, HookActionResult, HookDefinition, HookInvocationResult, } from '../plugin-runtime/hooks/hookTypes.js';
export type { PluginHookApi } from '../plugin-runtime/hooks/pluginHookApi.js';
export type { PluginUiSurface, PluginUiEventBridge, PluginUiUnmount, PluginUiFramework, } from '../plugin-runtime/ui/pluginUiTypes.js';
export type { PluginUiApi } from '../plugin-runtime/ui/pluginUiApi.js';
export type { WorkspaceTypeDefinition } from '../workspace-sheets/workspaceTypes.js';
export type { CodeHighlighterDefinition, RendererApi, } from '../plugin-runtime/renderers/rendererRegistry.js';
export type { PluginPresentationApi, } from '../plugin-runtime/presentation/pluginPresentationApi.js';
export type { PresentationProfileContribution } from '../plugin-runtime/presentation/presentationProfileTypes.js';
export type { PluginSettingsPageContribution, PluginSettingOptionsContribution, PluginSettingValue, } from '../plugin-runtime/settings/pluginSettingsTypes.js';
export type { PluginSettingsApi } from '../plugin-runtime/settings/pluginSettingsApi.js';
/** Framework-neutral settings schema/adapter contract for plugin pages and
 * context panels. Renderer-prefixed names remain available as compatibility
 * aliases from the same module. */
export type { SettingsSchema, SettingsField, SettingsValue, SettingsValueAdapter, RendererSettingsSchema, RenderSettingField, RendererSettingValue, RendererSettingOption, RendererSettingsPlacement, } from '../plugin-runtime/renderers/rendererSettingsTypes.js';
export type { SettingsTarget } from '../plugin-runtime/settings/settingsTargetGrammar.js';
export { validateSettingsTarget, stringifySettingsTarget, parseSettingsTarget, } from '../plugin-runtime/settings/settingsTargetGrammar.js';
export type { FontContribution, FontRole, } from '../plugin-runtime/fonts/fontContributionTypes.js';
export type { PluginSessionsApi, PluginTurnsApi } from '../plugin-runtime/sessionData/pluginSessionDataApi.js';
export type { SessionCreationContribution, SessionCreationCompiler, SessionCreationArtifactHandler, } from '../plugin-runtime/session-creation/sessionCreationTypes.js';
export type { PluginProcessApi, PluginProcessHandle } from '../plugin-runtime/process/processTypes.js';
export type { PluginServiceContribution, PluginServiceKind } from '../plugin-runtime/services/pluginServiceRegistry.js';
export type { AgentSidebarContribution } from '../plugin-runtime/sidebar/sidebarTypes.js';
export type { ContextPanelContribution } from '../plugin-runtime/context-panel/contextPanelTypes.js';
export type { FileWorkbenchContribution } from '../plugin-runtime/file-workbench/fileWorkbenchTypes.js';
export { VISUAL_SEMANTIC_TOKENS, VISUAL_SEMANTIC_ROLE_TOKENS } from '../domains/theme/visualSemantics.js';
export { PYLON_PLUGIN_API_MIN, 
/** @deprecated 语义是最低接受版本，改用 PYLON_PLUGIN_API_MIN */
PYLON_PLUGIN_API_VERSION, PYLON_PLUGIN_API_LATEST, PYLON_PLUGIN_API_SUPPORTED, PYLON_PLUGIN_CAPABILITIES, PYLON_PLUGIN_MANIFEST_FILE, };
export { PLUGIN_STORAGE_BUDGET_BYTES, PluginStorageError } from '../plugin-runtime/storage/pluginStorageContract.js';
/** Gives plugin entry modules a checked, inference-friendly lifecycle definition. */
export declare function definePlugin(module: PackagePluginModule): PackagePluginModule;
/** Parses and validates the package's pylon-plugin.json API 1.0 manifest. */
export declare function validatePluginManifest(value: unknown): PylonPluginManifest;
export interface PluginLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/** 统一 `[pluginId]` 前缀的 console 封装（琥珀色标签，宿主控制台可读性一致）。 */
export declare function createPluginLogger(pluginId: string): PluginLogger;
export type SettingsSurfaceField = {
    type: 'text';
    key: string;
    label: string;
    hint?: string;
    placeholder?: string;
    multiline?: boolean;
} | {
    type: 'toggle';
    key: string;
    label: string;
    hint?: string;
} | {
    type: 'number';
    key: string;
    label: string;
    hint?: string;
    min?: number;
    max?: number;
    step?: number;
} | {
    type: 'select';
    key: string;
    label: string;
    hint?: string;
    options: readonly {
        value: string;
        label: string;
    }[];
};
export type SettingsSurfaceValues = Readonly<Record<string, unknown>>;
export interface SettingsSurfaceDefinition {
    /** surface id（须与 settings.registerPage 的 surfaceId 一致）。 */
    id: string;
    /** 控件清单（渲染顺序即声明顺序）。 */
    fields: readonly SettingsSurfaceField[];
    /** 顶部说明（可选）。 */
    description?: string;
    /** 任一字段提交后回调（含乐观本地值；宿主持久化回流会再次触发 host:input）。 */
    onChange?: (key: string, value: unknown, values: SettingsSurfaceValues) => void;
}
/**
 * 把 §6.10 设置页协议（host:input 进 / settings:set·settings:remove 出）封装成
 * 声明式字段清单，输出可直接交给 `context.settings.registerPage` 的隔离
 * PluginUiSurface。纯 DOM 渲染，不依赖任何框架；样式消费宿主语义 token。
 */
export declare function createSettingsSurface(definition: SettingsSurfaceDefinition): PluginUiSurface;
