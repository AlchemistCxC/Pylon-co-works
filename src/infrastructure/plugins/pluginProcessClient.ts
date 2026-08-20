import type { ClientTransport } from './pluginClientTransport.ts'

export type ProcessStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'failed'
export type ProcessProtocol = 'raw' | 'lines' | 'json-lines' | 'json-rpc' | 'http'

export interface PluginPath {
  namespace: 'package' | 'data' | 'runtime'
  path?: string
}

export interface PluginProcessOptions {
  args?: string[]
  cwd?: PluginPath
  env?: Record<string, string>
  protocol?: ProcessProtocol
  restart?: {
    policy: 'never' | 'on-failure' | 'always'
    maxAttempts?: number
    backoffMs?: number
  }
  shutdown?: {
    method: 'stdin' | 'json-rpc' | 'signal' | 'kill'
    timeoutMs?: number
  }
}

export interface PluginProcessDescriptor {
  processId: string
  pluginId: string
  runtimeInstanceId: string
  executableId: string
  status: ProcessStatus
  pid?: number
  restartAttempts: number
}

export interface ProcessExit {
  exitCode?: number
  reason: string
}

export interface PluginProcessEvent {
  processId: string
  pluginId: string
  runtimeInstanceId: string
  sequence: number
  kind: string
  dataBase64?: string
  value?: unknown
}

export interface PluginProcessLogEntry extends PluginProcessEvent {
  kind: 'stdout' | 'stderr'
}

export interface PluginProcessEventTransport {
  listen(
    event: string,
    listener: (event: { payload: PluginProcessEvent }) => void,
  ): Promise<() => void>
}

export interface PluginProcessClientOptions {
  transport: ClientTransport
  events: PluginProcessEventTransport
}

export interface ProcessListenerDisposable {
  dispose(): void
}

export interface NativePluginProcessHandle {
  readonly processId: string
  readonly status: ProcessStatus
  write(data: string | Uint8Array): Promise<void>
  request<T>(method: string, params?: unknown, options?: { signal?: AbortSignal, timeoutMs?: number }): Promise<T>
  terminate(): Promise<void>
  kill(): Promise<void>
  onStdout(listener: (data: Uint8Array) => void): ProcessListenerDisposable
  onStderr(listener: (data: Uint8Array) => void): ProcessListenerDisposable
  onExit(listener: (exit: ProcessExit) => void): ProcessListenerDisposable
  dispose(): Promise<void>
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function disposable(remove: () => void): ProcessListenerDisposable {
  let active = true
  return {
    dispose() {
      if (!active) return
      active = false
      remove()
    },
  }
}

export function createPluginProcessClient(options: PluginProcessClientOptions) {
  const handles = new Map<string, ProcessHandle>()
  const earlyEvents = new Map<string, PluginProcessEvent[]>()
  let listenerReady: Promise<void> | undefined
  let requestSequence = 0

  class ProcessHandle implements NativePluginProcessHandle {
    readonly processId: string
    private currentStatus: ProcessStatus
    private lastExit: ProcessExit | undefined
    private readonly stdoutListeners = new Set<(data: Uint8Array) => void>()
    private readonly stderrListeners = new Set<(data: Uint8Array) => void>()
    private readonly exitListeners = new Set<(exit: ProcessExit) => void>()

    constructor(descriptor: PluginProcessDescriptor) {
      this.processId = descriptor.processId
      this.currentStatus = descriptor.status
    }

    get status(): ProcessStatus {
      return this.currentStatus
    }

    receive(event: PluginProcessEvent): void {
      if (event.kind === 'stdout' && event.dataBase64) {
        const data = base64ToBytes(event.dataBase64)
        for (const listener of [...this.stdoutListeners]) listener(data)
      } else if (event.kind === 'stderr' && event.dataBase64) {
        const data = base64ToBytes(event.dataBase64)
        for (const listener of [...this.stderrListeners]) listener(data)
      } else if (event.kind === 'status') {
        const status = (event.value as { status?: ProcessStatus } | undefined)?.status
        if (status) this.currentStatus = status
      } else if (event.kind === 'exit') {
        const value = event.value as { exitCode?: number | null, reason?: string } | undefined
        this.currentStatus = value?.reason === 'exited' || value?.reason === 'killed' ? 'exited' : 'failed'
        this.lastExit = {
          ...(typeof value?.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
          reason: value?.reason ?? 'exited',
        }
        for (const listener of [...this.exitListeners]) listener(this.lastExit)
      }
    }

    async write(data: string | Uint8Array): Promise<void> {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
      await options.transport.invoke('plugin_process_write', {
        processId: this.processId,
        dataBase64: bytesToBase64(bytes),
      })
    }

    async request<T>(
      method: string,
      params?: unknown,
      requestOptions: { signal?: AbortSignal, timeoutMs?: number } = {},
    ): Promise<T> {
      if (requestOptions.signal?.aborted) throw requestOptions.signal.reason
      const requestId = `${this.processId}:web:${++requestSequence}`
      const nativeRequest = options.transport.invoke('plugin_process_request', {
        processId: this.processId,
        method,
        params,
        timeoutMs: requestOptions.timeoutMs ?? 30_000,
        requestId,
      }) as Promise<T>
      if (!requestOptions.signal) return nativeRequest
      const signal = requestOptions.signal
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          void options.transport.invoke('plugin_process_cancel', {
            processId: this.processId,
            requestId,
          }).catch(() => undefined)
          reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        }
        signal.addEventListener('abort', abort, { once: true })
        nativeRequest.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
    }

    async terminate(): Promise<void> {
      await options.transport.invoke('plugin_process_terminate', { processId: this.processId })
    }

    async kill(): Promise<void> {
      await options.transport.invoke('plugin_process_kill', { processId: this.processId })
    }

    onStdout(listener: (data: Uint8Array) => void): ProcessListenerDisposable {
      this.stdoutListeners.add(listener)
      return disposable(() => this.stdoutListeners.delete(listener))
    }

    onStderr(listener: (data: Uint8Array) => void): ProcessListenerDisposable {
      this.stderrListeners.add(listener)
      return disposable(() => this.stderrListeners.delete(listener))
    }

    onExit(listener: (exit: ProcessExit) => void): ProcessListenerDisposable {
      this.exitListeners.add(listener)
      if (this.lastExit) queueMicrotask(() => listener(this.lastExit!))
      return disposable(() => this.exitListeners.delete(listener))
    }

    async dispose(): Promise<void> {
      await this.terminate()
      handles.delete(this.processId)
      this.stdoutListeners.clear()
      this.stderrListeners.clear()
      this.exitListeners.clear()
    }
  }

  function ensureListener(): Promise<void> {
    listenerReady ??= options.events.listen('pylon:plugin-process', event => {
      const handle = handles.get(event.payload.processId)
      if (handle) {
        handle.receive(event.payload)
        return
      }
      const queued = earlyEvents.get(event.payload.processId) ?? []
      queued.push(event.payload)
      if (queued.length > 64) queued.shift()
      earlyEvents.set(event.payload.processId, queued)
    }).then(() => undefined)
    return listenerReady
  }

  return {
    async spawn(
      pluginId: string,
      runtimeInstanceId: string,
      executableId: string,
      processOptions: PluginProcessOptions = {},
      packageInstanceId?: string,
    ): Promise<NativePluginProcessHandle> {
      await ensureListener()
      const descriptor = await options.transport.invoke('plugin_process_spawn', {
        pluginId,
        runtimeInstanceId,
        executableId,
        options: processOptions,
        ...(packageInstanceId ? { packageInstanceId } : {}),
      }) as PluginProcessDescriptor
      const handle = new ProcessHandle(descriptor)
      handles.set(descriptor.processId, handle)
      for (const event of earlyEvents.get(descriptor.processId) ?? []) handle.receive(event)
      earlyEvents.delete(descriptor.processId)
      return handle
    },
    list: (runtimeInstanceId?: string): Promise<PluginProcessDescriptor[]> =>
      options.transport.invoke('plugin_process_list', { runtimeInstanceId }) as Promise<PluginProcessDescriptor[]>,
    logs: (processId: string, stream?: 'stdout' | 'stderr', limit = 200): Promise<PluginProcessLogEntry[]> =>
      options.transport.invoke('plugin_process_logs', { processId, stream, limit }) as Promise<PluginProcessLogEntry[]>,
    terminate: (processId: string): Promise<void> =>
      options.transport.invoke('plugin_process_terminate', { processId }) as Promise<void>,
  }
}

export type PluginProcessClient = ReturnType<typeof createPluginProcessClient>
