/**
 * FakeEventBus — 模拟 Tauri 事件 listen/unlisten（阶段 0 测试夹具）。
 *
 * 能力：listen/unlisten 生命周期、emit 广播、指定事件下一次 listen reject
 * （listener 部分注册失败注入）、调用日志、listener 计数。
 * listen 签名与 @tauri-apps/api/event 的 listen 一致。
 */

export type UnlistenFn = () => void

export interface EventBusCall {
  event: string
  op: 'listen' | 'unlisten'
}

export interface FakeEventBusOptions {
  /** 这些事件的首次 listen 调用将 reject（部分注册失败注入） */
  failEvents?: string[]
}

export class FakeEventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>()
  private readonly failEvents = new Set<string>()
  readonly calls: EventBusCall[] = []

  constructor(options: FakeEventBusOptions = {}) {
    for (const event of options.failEvents ?? []) this.failEvents.add(event)
  }

  /** 与 @tauri-apps/api/event 的 listen 同签名 */
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    this.calls.push({ event, op: 'listen' })
    if (this.failEvents.has(event)) {
      this.failEvents.delete(event)
      return Promise.reject(new Error(`Failed to register listener for ${event}`))
    }
    const set = this.handlers.get(event) ?? new Set<(payload: unknown) => void>()
    this.handlers.set(event, set)
    set.add(handler as (payload: unknown) => void)
    return Promise.resolve(() => {
      this.calls.push({ event, op: 'unlisten' })
      set.delete(handler as (payload: unknown) => void)
    })
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0
  }

  /** 该事件下一次 listen 调用将 reject */
  failNext(event: string): void {
    this.failEvents.add(event)
  }

  reset(): void {
    this.handlers.clear()
    this.calls.length = 0
    this.failEvents.clear()
  }
}
