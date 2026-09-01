/**
 * Pylon 插件 SDK 测试基建（`@pylon/plugin-sdk/testing`）。
 *
 * 仅供插件的测试文件 import —— 不进入插件生产 bundle：
 * - 引用了宿主 PluginScope 真实类，保留真实的资源回收纪律；
 * - 记录式 mock：命令可执行、Hook 可分发、设置/存储/会话为内存实现、
 *   其余 13 个 API 面以 Proxy 记录调用（调用即记录，返回 undefined）。
 */
import { PluginScope } from '../plugin-runtime/pluginScope.ts'
import type { BuiltinPluginActivationContext } from '../plugin-runtime/pluginActivationContext.ts'
import type { PluginIdentity } from '../plugin-runtime/pluginIdentity.ts'
import type { PluginCommandApi } from '../plugin-runtime/commands/pluginCommandApi.ts'
import type { CommandDefinition, CommandExecutionContext } from '../plugin-runtime/commands/commandRegistry.ts'
import type { PluginHookApi } from '../plugin-runtime/hooks/pluginHookApi.ts'
import type { HookDefinition, HookInvocationResult, HookName } from '../plugin-runtime/hooks/hookTypes.ts'
import type { PluginSessionsApi, PluginTurnsApi } from '../plugin-runtime/sessionData/pluginSessionDataApi.ts'
import type { PluginSettingsApi } from '../plugin-runtime/settings/pluginSettingsApi.ts'
import type { PluginSettingValue } from '../plugin-runtime/settings/pluginSettingsTypes.ts'
import type { PluginStorageApi } from '../plugin-runtime/storage/pluginStorageTypes.ts'
import { PLUGIN_STORAGE_BUDGET_BYTES, PluginStorageError } from '../plugin-runtime/storage/pluginStorageContract.ts'
import { validatePluginKey } from '../plugin-runtime/settings/pluginKeyValidation.ts'
import type { PluginUiApi } from '../plugin-runtime/ui/pluginUiApi.ts'
import type { PluginUiSurface, PluginUiUnmount } from '../plugin-runtime/ui/pluginUiTypes.ts'
import type { AsyncDisposable } from '../plugin-runtime/registry/types.ts'

export interface MockRecordedCall {
  readonly member: string
  readonly method: string
  readonly args: readonly unknown[]
}

export interface MockContextOptions {
  pluginId?: string
  runtimeInstanceId?: string
  /** 预置 settings 值（键值即 PluginSettingsApi 语义） */
  settingsValues?: Record<string, PluginSettingValue>
  /** 预置 storage 值（按 PluginStorageApi 语义隔离） */
  storageValues?: Record<string, unknown>
}

export interface MockSurfaceDriver {
  container: HTMLElement
  /** 模拟宿主向 surface 派发输入（PluginSettingsPageHost 同款事件名） */
  hostInput(values: Record<string, unknown>): void
  events: Array<{ event: string; detail: unknown }>
  unmount(): Promise<void>
}

export interface MockPluginActivationContext extends BuiltinPluginActivationContext {
  readonly scope: PluginScope
  readonly __commands: {
    registered: CommandDefinition[]
    execute(id: string, args?: unknown): Promise<unknown>
  }
  readonly __hooks: {
    registered: Array<{ hookName: HookName; definition: HookDefinition }>
    dispatch(name: HookName, event: unknown): Promise<HookInvocationResult<unknown>>
  }
  readonly __ui: {
    surfaces: PluginUiSurface[]
    /** 按 surface id 挂载并返回驱动器（容器 + 桥） */
    mount(surfaceId: string): MockSurfaceDriver
  }
  readonly __settings: {
    values: Record<string, unknown>
    changeCount(): number
  }
  readonly __storage: {
    values: Record<string, unknown>
    changeCount(): number
  }
  readonly __recorded: readonly MockRecordedCall[]
  readonly __scopeDispose: () => Promise<void>
}

/** 其余 13 个 API 面：任何方法调用都被记录，返回 undefined */
function recordingApi<T extends object>(member: string, log: MockRecordedCall[]): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      return (...args: unknown[]) => {
        log.push({ member, method: prop, args: Object.freeze([...args]) })
        return undefined
      }
    },
  })
}

function cloneMockValue(value: unknown, field: string): unknown {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new PluginStorageError(
      field,
      `mock storage value must be cloneable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function mockStorage(initial: Record<string, unknown> = {}): {
  api: PluginStorageApi
  values: Record<string, unknown>
  changeCount: () => number
} {
  const values: Record<string, unknown> = Object.create(null)
  const listeners = new Set<() => void>()
  let writes = 0
  for (const [key, value] of Object.entries(initial)) {
    validatePluginKey(key, '插件存储')
    values[key] = cloneMockValue(value, 'value')
  }
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const api: PluginStorageApi = {
    getValue<T = unknown>(key: string): T | undefined {
      validatePluginKey(key, '插件存储')
      if (!Object.hasOwn(values, key)) return undefined
      return cloneMockValue(values[key], 'read') as T
    },
    setValue(key: string, value: unknown): void {
      validatePluginKey(key, '插件存储')
      const candidate = { ...values, [key]: cloneMockValue(value, 'value') }
      const size = new TextEncoder().encode(JSON.stringify(candidate)).byteLength
      if (size > PLUGIN_STORAGE_BUDGET_BYTES) throw new PluginStorageError('quota', 'mock storage quota exceeded')
      Object.keys(values).forEach(existing => { delete values[existing] })
      Object.assign(values, candidate)
      writes += 1
      notify()
    },
    removeValue(key: string): void {
      validatePluginKey(key, '插件存储')
      if (!Object.hasOwn(values, key)) return
      delete values[key]
      writes += 1
      notify()
    },
    keys: () => Object.keys(values),
    clear(): void {
      if (Object.keys(values).length === 0) return
      Object.keys(values).forEach(key => { delete values[key] })
      writes += 1
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return { api, values, changeCount: () => writes }
}

export function createMockContext(options: MockContextOptions = {}): MockPluginActivationContext {
  const pluginId = options.pluginId ?? 'mock.plugin'
  const runtimeInstanceId = options.runtimeInstanceId ?? 'mock-runtime-1'
  const identity: PluginIdentity = {
    pluginId,
    version: '0.0.0-mock',
    packageInstanceId: `${pluginId}#mock-package`,
    runtimeInstanceId,
    instanceId: `${pluginId}#${runtimeInstanceId}`,
    key: `${pluginId}#${runtimeInstanceId}`,
  }
  const scope = new PluginScope(`mock:${pluginId}`)

  const commandBucket: CommandDefinition[] = []
  const hookBucket: Array<{ hookName: HookName; definition: HookDefinition }> = []
  const surfaces: PluginUiSurface[] = []
  const sessionMeta = new Map<string, Record<string, unknown>>()
  const sessionCtx = new Map<string, Record<string, unknown>>()
  const turnMeta = new Map<string, Record<string, unknown>>()
  const turnCtx = new Map<string, Record<string, unknown>>()
  const turnKnown = new Set<string>()
  const settingsValues: Record<string, PluginSettingValue> = { ...(options.settingsValues ?? {}) }
  const storageHarness = mockStorage(options.storageValues)
  const settingsListeners = new Set<() => void>()
  const recorded: MockRecordedCall[] = []
  let settingsWrites = 0

  const disposable = (dispose: () => void): AsyncDisposable => ({ dispose })
  const executeCommand = async <T = unknown>(id: string, args?: unknown, options?: { signal?: AbortSignal }): Promise<T> => {
    const def = commandBucket.find(entry => entry.id === id)
    if (!def) throw new Error(`mock: 命令 ${id} 未注册`)
    if (!def.execute) throw new Error(`mock: 命令 ${id} 不可执行`)
    if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    const execCtx: CommandExecutionContext = { commandId: id, args, signal: options?.signal }
    return await def.execute(execCtx) as T
  }
  const commands: PluginCommandApi = {
    register: definition => {
      commandBucket.push(definition)
      return scope.add(disposable(() => {
        const index = commandBucket.indexOf(definition)
        if (index >= 0) commandBucket.splice(index, 1)
      }))
    },
    execute: executeCommand,
    list: () => [],
    describe: () => null,
  }
  const dispatchHooks = async <TEvent>(name: HookName, event: TEvent): Promise<HookInvocationResult<TEvent>> => {
    const defs = hookBucket
      .filter(entry => entry.hookName === name)
      .sort((left, right) => (right.definition.priority ?? 100) - (left.definition.priority ?? 100))
    let current = event
    let executed = 0
    for (const { definition } of defs) {
      const result = await definition.handler({
        invocationId: `mock-${name}-${executed}`,
        hookName: name,
        event: current,
        signal: new AbortController().signal,
      })
      if (!result || result.action === 'continue') {
        if (result && 'event' in result && result.event !== undefined) current = result.event as TEvent
        executed += 1
        continue
      }
      if (result.action === 'cancel') {
        return { action: 'cancel', event: current, executed: executed + 1, skipped: 0, reason: result.reason }
      }
      if (result.action === 'respond') {
        return { action: 'respond', event: current, output: result.output, executed: executed + 1, skipped: 0 }
      }
      executed += 1
    }
    return { action: 'continue', event: current, executed, skipped: 0 }
  }
  const hooks: PluginHookApi = {
    register: (hookName, definition) => {
      const entry = { hookName, definition }
      hookBucket.push(entry)
      return scope.add(disposable(() => {
        const index = hookBucket.indexOf(entry)
        if (index >= 0) hookBucket.splice(index, 1)
      }))
    },
    invoke: dispatchHooks,
  }
  const cloneNamespace = (value: Record<string, unknown>): Record<string, unknown> => (
    JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  )
  const sessions: PluginSessionsApi = {
    getPluginMetadata: sessionId => cloneNamespace(sessionMeta.get(sessionId) ?? {}),
    setPluginMetadata: (sessionId, patch) => {
      const prev = sessionMeta.get(sessionId) ?? {}
      sessionMeta.set(sessionId, cloneNamespace({ ...prev, ...patch }))
      return true
    },
    getPluginContext: sessionId => cloneNamespace(sessionCtx.get(sessionId) ?? {}),
    setPluginContext: (sessionId, patch) => {
      const prev = sessionCtx.get(sessionId) ?? {}
      sessionCtx.set(sessionId, cloneNamespace({ ...prev, ...patch }))
      return true
    },
  }
  const turns: PluginTurnsApi = {
    ensure: turn => { turnKnown.add(turn.id); return true },
    getPluginMetadata: turnId => cloneNamespace(turnMeta.get(turnId) ?? {}),
    setPluginMetadata: (turnId, patch) => {
      if (!turnKnown.has(turnId)) return false
      turnMeta.set(turnId, cloneNamespace({ ...(turnMeta.get(turnId) ?? {}), ...patch }))
      return true
    },
    getPluginContext: turnId => cloneNamespace(turnCtx.get(turnId) ?? {}),
    setPluginContext: (turnId, patch) => {
      if (!turnKnown.has(turnId)) return false
      turnCtx.set(turnId, cloneNamespace({ ...(turnCtx.get(turnId) ?? {}), ...patch }))
      return true
    },
  }
  const settings: PluginSettingsApi = {
    registerPage: () => {},
    registerOptions: () => {},
    getValue: key => settingsValues[key],
    setValue: (key, value) => {
      settingsValues[key] = value
      settingsWrites += 1
      settingsListeners.forEach(listener => listener())
    },
    removeValue: key => {
      delete settingsValues[key]
      settingsWrites += 1
      settingsListeners.forEach(listener => listener())
    },
    subscribe: listener => {
      settingsListeners.add(listener)
      return () => { settingsListeners.delete(listener) }
    },
  }
  const ui: PluginUiApi = {
    registerSurface: (surface: PluginUiSurface) => { surfaces.push(surface) },
  }

  const context = {
    identity,
    scope,
    application: recordingApi('application', recorded),
    workspace: recordingApi('workspace', recorded),
    renderer: recordingApi('renderer', recorded),
    commands,
    hooks,
    sessions,
    turns,
    process: recordingApi('process', recorded),
    ui,
    services: recordingApi('services', recorded),
    sidebar: recordingApi('sidebar', recorded),
    fileWorkbench: recordingApi('fileWorkbench', recorded),
    contextPanel: recordingApi('contextPanel', recorded),
    presentation: recordingApi('presentation', recorded),
    settings,
    fonts: recordingApi('fonts', recorded),
    sessionCreation: recordingApi('sessionCreation', recorded),
    interfaceModes: recordingApi('interfaceModes', recorded),
    titlebar: recordingApi('titlebar', recorded),
    storage: storageHarness.api,
  } satisfies BuiltinPluginActivationContext

  const mock = context as MockPluginActivationContext
  Object.defineProperty(mock, '__commands', {
    value: {
      registered: commandBucket,
      execute: executeCommand,
    },
  })
  Object.defineProperty(mock, '__hooks', {
    value: {
      registered: hookBucket,
      dispatch: dispatchHooks,
    },
  })
  Object.defineProperty(mock, '__ui', {
    value: {
      surfaces,
      mount(surfaceId: string): MockSurfaceDriver {
        const surface = surfaces.find(entry => entry.id === surfaceId)
        if (!surface) throw new Error(`mock: surface ${surfaceId} 未注册`)
        const container = document.createElement('div')
        const events: Array<{ event: string; detail: unknown }> = []
        const handlers = new Map<string, Set<(detail: unknown) => void>>()
        const bridge = {
          on(event: string, listener: (detail: unknown) => void): () => void {
            const bucket = handlers.get(event)
            if (bucket) bucket.add(listener)
            else handlers.set(event, new Set([listener]))
            return () => { handlers.get(event)?.delete(listener) }
          },
          emit(event: string, detail: unknown): void {
            events.push({ event, detail })
            handlers.get(event)?.forEach(listener => listener(detail))
          },
          clear(): void { events.length = 0 },
        }
        let disposed = false
        let unmountPromise: Promise<void> | undefined
        const disposeSurface = async (value: PluginUiUnmount): Promise<void> => {
          if (typeof value === 'function') await value()
          else if (value && typeof value === 'object') await value.unmount()
        }
        let mountResult: PluginUiUnmount | Promise<PluginUiUnmount>
        try {
          mountResult = surface.mount(container, bridge)
        } catch (error) {
          mountResult = Promise.reject(error)
        }
        const mountPromise = Promise.resolve(mountResult)
        // 与 PluginSettingsPageHost 同款回写：surface 的 settings:set/remove 直通设置存储
        bridge.on('settings:set', detail => {
          const payload = detail as { key?: string; value?: unknown }
          if (typeof payload?.key === 'string') settings.setValue(payload.key, payload.value as PluginSettingValue)
        })
        bridge.on('settings:remove', detail => {
          if (typeof detail === 'string') settings.removeValue(detail)
        })
        // 与 PluginSettingsPageHost 一致：挂载后立即派发一次 host:input（当前持久化值）
        if (mountResult && typeof (mountResult as PromiseLike<PluginUiUnmount>).then === 'function') {
          void mountPromise.then(() => {
            if (disposed) return undefined
            bridge.emit('host:input', { pluginId, pageId: surfaceId, values: settingsValues })
            return undefined
          }).catch(error => {
            events.push({ event: 'ui:mount-error', detail: error })
          })
        } else {
          bridge.emit('host:input', { pluginId, pageId: surfaceId, values: settingsValues })
        }
        return {
          container,
          events,
          hostInput(values: Record<string, unknown>): void {
            bridge.emit('host:input', { pluginId, pageId: surfaceId, values })
          },
          unmount(): Promise<void> {
            if (unmountPromise) return unmountPromise
            disposed = true
            container.replaceChildren()
            unmountPromise = mountPromise
              .then(value => disposeSurface(value))
              .catch(error => { events.push({ event: 'ui:unmount-error', detail: error }) })
              .then(() => { handlers.clear() })
            return unmountPromise
          },
        }
      },
    },
  })
  Object.defineProperty(mock, '__settings', {
    value: {
      values: settingsValues,
      changeCount: () => settingsWrites,
    },
  })
  Object.defineProperty(mock, '__storage', {
    value: {
      values: storageHarness.values,
      changeCount: storageHarness.changeCount,
    },
  })
  Object.defineProperty(mock, '__recorded', {
    get: () => Object.freeze([...recorded]),
  })
  Object.defineProperty(mock, '__scopeDispose', { value: () => scope.dispose() })

  return mock
}

export type { PluginUiEventBridge } from '../plugin-runtime/ui/pluginUiTypes.ts'
export { PluginStorageError } from '../plugin-runtime/storage/pluginStorageContract.ts'
