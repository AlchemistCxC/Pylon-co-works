export type PluginResourceDisposable = (() => void | Promise<void>) | {
  dispose: () => void | Promise<void>
}

export interface PluginResourceMetadata {
  readonly resourceId?: string
  readonly label?: string
}

export interface PluginCleanupError {
  readonly resourceId: string
  readonly message: string
}

export interface PluginScopeDisposeResult {
  readonly disposed: number
  readonly remaining: number
  readonly errors: readonly PluginCleanupError[]
}

interface PluginResourceRecord {
  readonly resourceId: string
  readonly label?: string
  readonly dispose: () => void | Promise<void>
}

function normalizeDisposable(resource: PluginResourceDisposable): () => void | Promise<void> {
  return typeof resource === 'function' ? resource : () => resource.dispose()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PluginScope {
  readonly ownerKey: string
  private resources: PluginResourceRecord[] = []
  private closing = false
  private disposed = false
  private resourceSequence = 0
  private disposal: Promise<PluginScopeDisposeResult> | undefined

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

  add<T extends PluginResourceDisposable>(resource: T, metadata: PluginResourceMetadata = {}): T {
    if (this.closing) throw new Error(`PluginScope 已释放：${this.ownerKey}`)
    const resourceId = metadata.resourceId ?? `${this.ownerKey}:resource-${++this.resourceSequence}`
    if (this.resources.some(record => record.resourceId === resourceId)) {
      throw new Error(`PluginScope resourceId 重复：${resourceId}`)
    }
    this.resources.push({
      resourceId,
      label: metadata.label,
      dispose: normalizeDisposable(resource),
    })
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
    this.add(remove, { label: `event:${type}` })
    return remove
  }

  setTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): ReturnType<typeof setTimeout> {
    const handle = globalThis.setTimeout(handler, timeout, ...args)
    this.add(() => globalThis.clearTimeout(handle), { label: 'timeout' })
    return handle
  }

  setInterval(handler: TimerHandler, timeout?: number, ...args: unknown[]): ReturnType<typeof setInterval> {
    const handle = globalThis.setInterval(handler, timeout, ...args)
    this.add(() => globalThis.clearInterval(handle), { label: 'interval' })
    return handle
  }

  createAbortController(): AbortController {
    const controller = new AbortController()
    this.add(
      () => controller.abort(`PluginScope disposed: ${this.ownerKey}`),
      { label: 'abort-controller' },
    )
    return controller
  }

  disposeNow(): Promise<PluginScopeDisposeResult> {
    return this.dispose()
  }

  dispose(): Promise<PluginScopeDisposeResult> {
    if (this.disposal) return this.disposal
    this.closing = true
    const operation = this.performDispose()
    this.disposal = operation
    void operation.finally(() => {
      if (this.disposal === operation) this.disposal = undefined
    })
    return operation
  }

  private async performDispose(): Promise<PluginScopeDisposeResult> {
    let disposed = 0
    const errors: PluginCleanupError[] = []
    for (const record of [...this.resources].reverse()) {
      try {
        await record.dispose()
        this.resources = this.resources.filter(item => item.resourceId !== record.resourceId)
        disposed += 1
      } catch (error) {
        errors.push(Object.freeze({
          resourceId: record.resourceId,
          message: messageOf(error),
        }))
      }
    }
    this.disposed = this.resources.length === 0
    return Object.freeze({
      disposed,
      remaining: this.resources.length,
      errors: Object.freeze(errors),
    })
  }
}
