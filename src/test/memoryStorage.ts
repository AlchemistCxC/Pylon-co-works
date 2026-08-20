/**
 * MemoryStorage — 可注入故障的内存 StorageLike（阶段 0 测试夹具）。
 *
 * 能力：正常 get/set/remove 与调用日志（断言"写盘内容与内存一致"用）；
 * 预置初始数据（可注入损坏 JSON）；quota exceeded、指定 key 写失败、指定 key
 * 删除失败均可注入并可中途切换。
 */

export interface StorageCall {
  op: 'getItem' | 'setItem' | 'removeItem'
  key: string
}

export interface MemoryStorageOptions {
  /** 预置初始数据（key → raw string，可注入损坏 JSON） */
  initial?: Record<string, string>
  /** setItem 抛 QuotaExceededError（可中途切换） */
  quotaExceeded?: boolean
  /** 这些 key 的 setItem 抛 Error（可中途切换） */
  failKeys?: string[]
  /** 这些 key 的 removeItem 抛 Error */
  readonlyKeys?: string[]
}

export class MemoryStorage {
  readonly calls: StorageCall[] = []
  private readonly data = new Map<string, string>()
  private quota: boolean
  private failing: Set<string>
  private readonly readonlyKeys: Set<string>

  constructor(options: MemoryStorageOptions = {}) {
    this.quota = options.quotaExceeded ?? false
    this.failing = new Set(options.failKeys ?? [])
    this.readonlyKeys = new Set(options.readonlyKeys ?? [])
    for (const [key, value] of Object.entries(options.initial ?? {})) this.data.set(key, value)
  }

  get length(): number {
    return this.data.size
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    this.calls.push({ op: 'getItem', key })
    return this.data.has(key) ? this.data.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.calls.push({ op: 'setItem', key })
    if (this.quota) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }
    if (this.failing.has(key)) {
      throw new Error(`simulated setItem failure for key "${key}"`)
    }
    this.data.set(key, value)
  }

  removeItem(key: string): void {
    this.calls.push({ op: 'removeItem', key })
    if (this.readonlyKeys.has(key)) {
      throw new Error(`simulated removeItem failure for key "${key}"`)
    }
    this.data.delete(key)
  }

  clear(): void {
    this.data.clear()
  }

  setQuotaExceeded(on: boolean): void {
    this.quota = on
  }

  setFailKeys(keys: string[]): void {
    this.failing = new Set(keys)
  }

  /** 当前存储内容快照（断言持久化结果用） */
  dump(): Record<string, string> {
    return Object.fromEntries(this.data)
  }
}
