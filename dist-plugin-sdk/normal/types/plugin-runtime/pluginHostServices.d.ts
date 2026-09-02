import type { PluginProcessClient } from '../infrastructure/plugins/pluginProcessClient.js';
import type { WorkspaceRegistryStore } from '../workspace-sheets/workspaceRegistry.js';
import type { PluginApplicationHost } from './application/applicationHost.js';
import type { CommandRegistry } from './commands/commandRegistry.js';
import type { ContextPanelRegistry } from './context-panel/contextPanelRegistry.js';
import type { PluginEventBus } from './events/pluginEventBus.js';
import type { FileWorkbenchRegistry } from './file-workbench/fileWorkbenchRegistry.js';
import type { FontContributionRegistry } from './fonts/fontContributionRegistry.js';
import type { HookRuntime } from './hooks/hookRuntime.js';
import type { InterfaceModeRegistry } from './interface-mode/interfaceModeRegistry.js';
import type { PresentationProfileRegistry } from './presentation/presentationProfileRegistry.js';
import type { RegistryHub } from './registry/registryHub.js';
import type { RendererRegistry } from './renderers/rendererRegistry.js';
import type { SessionCreationRegistry } from './session-creation/sessionCreationRegistry.js';
import type { PluginServiceRegistry } from './services/pluginServiceRegistry.js';
import type { PluginSettingOptionsRegistry } from './settings/pluginSettingOptionsRegistry.js';
import type { PluginSettingsPageRegistry } from './settings/pluginSettingsRegistry.js';
import type { PluginSettingsStore } from './settings/pluginSettingsStore.js';
import type { AgentSidebarRegistry } from './sidebar/sidebarRegistry.js';
import type { PluginUiRegistry } from './ui/pluginUiRegistry.js';
import type { TitlebarRegistry } from './titlebar/titlebarRegistry.js';
export interface RuntimeRegistries {
    readonly registryHub: RegistryHub;
    readonly commandRegistry: CommandRegistry;
    readonly eventBus: PluginEventBus;
    readonly rendererRegistry: RendererRegistry;
    readonly pluginUiRegistry: PluginUiRegistry;
    readonly pluginServiceRegistry: PluginServiceRegistry;
    readonly agentSidebarRegistry: AgentSidebarRegistry;
    readonly fileWorkbenchRegistry: FileWorkbenchRegistry;
    readonly contextPanelRegistry: ContextPanelRegistry;
    readonly presentationProfileRegistry: PresentationProfileRegistry;
    readonly pluginSettingsPageRegistry: PluginSettingsPageRegistry;
    readonly pluginSettingsStore: PluginSettingsStore;
    readonly pluginSettingOptionsRegistry: PluginSettingOptionsRegistry;
    readonly fontContributionRegistry: FontContributionRegistry;
    readonly sessionCreationRegistry: SessionCreationRegistry;
    readonly interfaceModeRegistry: InterfaceModeRegistry;
    readonly titlebarRegistry: TitlebarRegistry;
    readonly workspaceRegistry: WorkspaceRegistryStore;
}
export interface PluginHostServices {
    readonly application: PluginApplicationHost;
    readonly registries: RuntimeRegistries;
    readonly hooks: HookRuntime;
    readonly processClient: PluginProcessClient;
    readonly requestSoftRemount?: () => void | Promise<void>;
}
