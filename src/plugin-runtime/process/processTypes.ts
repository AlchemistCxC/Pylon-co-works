export type {
  PluginPath,
  PluginProcessDescriptor,
  PluginProcessOptions,
  ProcessExit,
  ProcessListenerDisposable,
  ProcessProtocol,
  ProcessStatus,
} from '../../infrastructure/plugins/pluginProcessClient.ts'

import type {
  PluginProcessDescriptor,
  PluginProcessOptions,
  NativePluginProcessHandle,
} from '../../infrastructure/plugins/pluginProcessClient.ts'

export type PluginProcessHandle = NativePluginProcessHandle

export interface PluginProcessApi {
  spawn(executableId: string, options?: PluginProcessOptions): Promise<PluginProcessHandle>
  list(): Promise<PluginProcessDescriptor[]>
}
