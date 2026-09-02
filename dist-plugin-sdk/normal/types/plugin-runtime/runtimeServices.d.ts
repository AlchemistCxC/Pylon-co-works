import { CommandRegistry } from './commands/commandRegistry.js';
import { PluginEventBus } from './events/pluginEventBus.js';
import { HookRuntime } from './hooks/hookRuntime.js';
import { RegistryHub } from './registry/registryHub.js';
import { RendererRegistry } from './renderers/rendererRegistry.js';
import { type RendererSettingsStore } from './renderers/rendererSettingsStore.js';
import { PluginUiRegistry } from './ui/pluginUiRegistry.js';
import { PluginServiceRegistry } from './services/pluginServiceRegistry.js';
import { AgentSidebarRegistry } from './sidebar/sidebarRegistry.js';
import { FileWorkbenchRegistry } from './file-workbench/fileWorkbenchRegistry.js';
import { ContextPanelRegistry } from './context-panel/contextPanelRegistry.js';
import { PresentationProfileRegistry } from './presentation/presentationProfileRegistry.js';
import { PluginSettingsPageRegistry } from './settings/pluginSettingsRegistry.js';
import { PluginSettingsStore } from './settings/pluginSettingsStore.js';
import { PluginSettingOptionsRegistry } from './settings/pluginSettingOptionsRegistry.js';
import { FontContributionRegistry } from './fonts/fontContributionRegistry.js';
import { SessionCreationRegistry } from './session-creation/sessionCreationRegistry.js';
import { InterfaceModeRegistry } from './interface-mode/interfaceModeRegistry.js';
import { TitlebarRegistry } from './titlebar/titlebarRegistry.js';
import { WorkspaceRegistryStore } from '../workspace-sheets/workspaceRegistry.js';
import type { RuntimeRegistries } from './pluginHostServices.js';
export interface RuntimeServices extends RuntimeRegistries {
    readonly hookRuntime: HookRuntime;
    readonly rendererSettingsStore: RendererSettingsStore;
}
export interface CreateRuntimeServicesOptions {
    hookRuntime?: HookRuntime;
    workspaceRegistry?: WorkspaceRegistryStore;
    rendererSettingsStore?: RendererSettingsStore;
}
export declare function createRuntimeServices(options?: CreateRuntimeServicesOptions): RuntimeServices;
type PluginDisableHandler = (pluginId: string) => void | Promise<void>;
/** Composition-root seam: binds hook failure isolation to the single product runtime. */
export declare function bindPluginDisableHandler(handler: PluginDisableHandler): void;
export declare function getRuntimeServices(): RuntimeServices;
export declare function getRegistryHub(): RegistryHub;
export declare function getCommandRegistry(): CommandRegistry;
export declare function getPluginEventBus(): PluginEventBus;
export declare function getHookRuntime(): HookRuntime;
export declare function getRendererRegistry(): RendererRegistry;
export declare function getRendererSettingsStore(): RendererSettingsStore;
export declare function getPluginUiRegistry(): PluginUiRegistry;
export declare function getPluginServiceRegistry(): PluginServiceRegistry;
export declare function getAgentSidebarRegistry(): AgentSidebarRegistry;
export declare function getFileWorkbenchRegistry(): FileWorkbenchRegistry;
export declare function getContextPanelRegistry(): ContextPanelRegistry;
export declare function getPresentationProfileRegistry(): PresentationProfileRegistry;
export declare function getPluginSettingsPageRegistry(): PluginSettingsPageRegistry;
export declare function getPluginSettingsStore(): PluginSettingsStore;
export declare function getPluginSettingOptionsRegistry(): PluginSettingOptionsRegistry;
export declare function getFontContributionRegistry(): FontContributionRegistry;
export declare function getSessionCreationRegistry(): SessionCreationRegistry;
export declare function getInterfaceModeRegistry(): InterfaceModeRegistry;
export declare function getTitlebarRegistry(): TitlebarRegistry;
export {};
