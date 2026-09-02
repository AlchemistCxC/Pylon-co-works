export type { PluginPath, PluginProcessDescriptor, PluginProcessOptions, ProcessExit, ProcessListenerDisposable, ProcessProtocol, ProcessStatus, } from '../../infrastructure/plugins/pluginProcessClient.js';
import type { PluginProcessDescriptor, PluginProcessOptions, NativePluginProcessHandle } from '../../infrastructure/plugins/pluginProcessClient.js';
export type PluginProcessHandle = NativePluginProcessHandle;
export interface PluginProcessApi {
    spawn(executableId: string, options?: PluginProcessOptions): Promise<PluginProcessHandle>;
    list(): Promise<PluginProcessDescriptor[]>;
}
