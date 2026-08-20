/**
 * FakeInvoke — 可编程的 Tauri invoke 夹具（阶段 0 测试夹具）。
 *
 * 能力：按 command 注册 handler、记录全部调用、per-command 延迟、handler 抛错 reject、
 * 永不返回（超时场景）、全局 reject。invoke 签名与 @tauri-apps/api/core 的 invoke 一致，
 * 可注入 transport，也可在测试中直接调用。
 */

export type InvokeHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>

export interface InvokeCall {
  cmd: string
  args: unknown
}

export interface FakeInvokeOptions {
  /** 所有命令的默认延迟 ms（0 = 立即 settle） */
  defaultDelay?: number
}

export class FakeInvoke {
  readonly calls: InvokeCall[] = []
  private readonly handlers = new Map<string, InvokeHandler>()
  private readonly delays = new Map<string, number>()
  private readonly neverCmds = new Set<string>()
  private rejectAllMessage: string | null = null
  private readonly defaultDelay: number

  constructor(options: FakeInvokeOptions = {}) {
    this.defaultDelay = options.defaultDelay ?? 0
  }

  register(cmd: string, handler: InvokeHandler): this {
    this.handlers.set(cmd, handler)
    return this
  }

  registerMany(table: Record<string, InvokeHandler>): this {
    for (const [cmd, handler] of Object.entries(table)) this.register(cmd, handler)
    return this
  }

  setDelay(cmd: string, ms: number): this {
    this.delays.set(cmd, ms)
    return this
  }

  /** 该命令的 invoke 永不 settle（超时/悬挂场景） */
  never(cmd: string): this {
    this.neverCmds.add(cmd)
    return this
  }

  /** 之后所有 invoke 一律 reject */
  rejectAll(message = 'invoke rejected'): this {
    this.rejectAllMessage = message
    return this
  }

  /** 与 @tauri-apps/api/core 的 invoke 同签名（args 宽松接受 typed payload） */
  invoke(cmd: string, args: unknown = {}): Promise<unknown> {
    this.calls.push({ cmd, args })
    if (this.neverCmds.has(cmd)) {
      return new Promise<never>(() => {})
    }
    const delay = this.delays.get(cmd) ?? this.defaultDelay
    const run = (): unknown => {
      if (this.rejectAllMessage !== null) throw new Error(this.rejectAllMessage)
      const handler = this.handlers.get(cmd)
      if (!handler) throw new Error(`Command not found: ${cmd}`)
      return handler(args as Record<string, unknown>)
    }
    if (delay > 0) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(run())
          } catch (error) {
            reject(error)
          }
        }, delay)
      })
    }
    return Promise.resolve().then(run)
  }
}
