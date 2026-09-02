import type { ClientTransport } from './pluginClientTransport.js';
export type ProcessStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'failed';
export type ProcessProtocol = 'raw' | 'lines' | 'json-lines' | 'json-rpc' | 'http';
export interface PluginPath {
    namespace: 'package' | 'data' | 'runtime';
    path?: string;
}
export interface PluginProcessOptions {
    args?: string[];
    cwd?: PluginPath;
    env?: Record<string, string>;
    protocol?: ProcessProtocol;
    restart?: {
        policy: 'never' | 'on-failure' | 'always';
        maxAttempts?: number;
        backoffMs?: number;
    };
    shutdown?: {
        method: 'stdin' | 'json-rpc' | 'signal' | 'kill';
        timeoutMs?: number;
    };
}
export interface PluginProcessDescriptor {
    processId: string;
    pluginId: string;
    runtimeInstanceId: string;
    executableId: string;
    status: ProcessStatus;
    pid?: number;
    restartAttempts: number;
}
export interface ProcessExit {
    exitCode?: number;
    reason: string;
}
export interface PluginProcessEvent {
    processId: string;
    pluginId: string;
    runtimeInstanceId: string;
    sequence: number;
    kind: string;
    dataBase64?: string;
    value?: unknown;
}
export interface PluginProcessLogEntry extends PluginProcessEvent {
    kind: 'stdout' | 'stderr';
}
export interface PluginProcessEventTransport {
    listen(event: string, listener: (event: {
        payload: PluginProcessEvent;
    }) => void): Promise<() => void>;
}
export interface PluginProcessClientOptions {
    transport: ClientTransport;
    events: PluginProcessEventTransport;
}
export interface ProcessListenerDisposable {
    dispose(): void;
}
export interface NativePluginProcessHandle {
    readonly processId: string;
    readonly status: ProcessStatus;
    write(data: string | Uint8Array): Promise<void>;
    request<T>(method: string, params?: unknown, options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<T>;
    terminate(): Promise<void>;
    kill(): Promise<void>;
    onStdout(listener: (data: Uint8Array) => void): ProcessListenerDisposable;
    onStderr(listener: (data: Uint8Array) => void): ProcessListenerDisposable;
    onExit(listener: (exit: ProcessExit) => void): ProcessListenerDisposable;
    dispose(): Promise<void>;
}
export declare function createPluginProcessClient(options: PluginProcessClientOptions): {
    spawn(pluginId: string, runtimeInstanceId: string, executableId: string, processOptions?: PluginProcessOptions, packageInstanceId?: string): Promise<NativePluginProcessHandle>;
    list: (runtimeInstanceId?: string) => Promise<PluginProcessDescriptor[]>;
    logs: (processId: string, stream?: "stdout" | "stderr", limit?: number) => Promise<PluginProcessLogEntry[]>;
    terminate: (processId: string) => Promise<void>;
};
export type PluginProcessClient = ReturnType<typeof createPluginProcessClient>;
