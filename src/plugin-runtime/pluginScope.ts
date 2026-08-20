export type PluginResourceDisposable = (() => void | Promise<void>) | {
  dispose: () => void | Promise<void>
}

export interface PluginScopeDisposeResult {
  disposed: number
  errors: unknown[]
}

function normalizeDisposable(resource: PluginResourceDisposable): () => void | Promise<void> {
  return typeof resource === 'function' ? resource : () => resource.dispose()
}

export class PluginScope {
  readonly ownerKey: string
  private resources: Array<() => void | Promise<void>> = []
  private disposed = false

  constructor(ownerKey: string) {
    if (!ownerKey) throw new Error('PluginScope ownerKey 不能为空')
    this.ownerKey = ownerKey
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get size(): number {
    return this.resources.length
  }

  add<T extends PluginResourceDisposable>(resource: T): T {
    if (this.disposed) throw new Error(`PluginScope 已释放：${this.ownerKey}`)
    this.resources.push(normalizeDisposable(resource))
    return resource
  }

  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): () => void {
    target.addEventListener(type, listener, options)
    let removed = false
    const remove = () => {
      if (removed) return
      removed = true
      target.removeEventListener(type, listener, options)
    }
    this.add(remove)
    return remove
  }

  setTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): ReturnType<typeof setTimeout> {
    const handle = globalThis.setTimeout(handler, timeout, ...args)
    this.add(() => globalThis.clearTimeout(handle))
    return handle
  }

  setInterval(handler: TimerHandler, timeout?: number, ...args: unknown[]): ReturnType<typeof setInterval> {
    const handle = globalThis.setInterval(handler, timeout, ...args)
    this.add(() => globalThis.clearInterval(handle))
    return handle
  }

  createAbortController(): AbortController {
    const controller = new AbortController()
    this.add(() => controller.abort(`PluginScope disposed: ${this.ownerKey}`))
    return controller
  }

  disposeNow(): PluginScopeDisposeResult {
    if (this.disposed) return { disposed: 0, errors: [] }
    this.disposed = true
    const resources = this.resources.splice(0).reverse()
    const errors: unknown[] = []
    for (const dispose of resources) {
      try {
        const result = dispose()
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).catch(error => errors.push(error))
        }
      } catch (error) {
        errors.push(error)
      }
    }
    return { disposed: resources.length, errors }
  }

  async dispose(): Promise<PluginScopeDisposeResult> {
    if (this.disposed) return { disposed: 0, errors: [] }
    this.disposed = true
    const resources = this.resources.splice(0).reverse()
    const errors: unknown[] = []
    for (const dispose of resources) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    return { disposed: resources.length, errors }
  }
}
