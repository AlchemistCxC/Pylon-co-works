import { describe, expect, it, beforeEach, vi } from 'vitest'
import { attachSolidPersist, createSolidStoreKernel, resolveLocalStorage, type PersistStringStorage } from '../solidStoreKernel'

describe('solidStoreKernel（#515 批0 门面语义）', () => {
  describe('zustand vanilla 门面等价', () => {
    it('setState(partial) 浅合并；函数 updater 返回同一引用时整体跳过（不写不通知）', () => {
      const kernel = createSolidStoreKernel({ count: 0, items: ['a'] as string[] | never[], noop: () => {} })
      const seen: Array<{ count: number }> = []
      kernel.subscribe(s => seen.push({ count: s.count }))

      kernel.setState({ count: 1 })
      expect(kernel.getState().count).toBe(1)
      expect(seen).toEqual([{ count: 1 }])

      // 同引用跳过：updater 原样返回 state（zustand v5 同款）
      kernel.setState(state => state)
      expect(seen).toEqual([{ count: 1 }])
      expect(kernel.getVersion()).toBe(1)
    })

    it('updater 返回新对象时合并并通知；嵌套对象写入方负责 clone（不可变约定）', () => {
      const kernel = createSolidStoreKernel<{ count: number; nested: { v: number } }>({ count: 0, nested: { v: 0 } })
      kernel.setState(s => ({ count: s.count + 1, nested: { v: s.nested.v + 1 } }))
      expect(kernel.getState()).toMatchObject({ count: 1, nested: { v: 1 } })
    })

    it('setState(next, true) 整体替换（reconcile 语义：键集对齐 next，缺席键删除）', () => {
      const kernel = createSolidStoreKernel<{ a: number; b: number; gone: string }>({ a: 1, b: 2, gone: 'x' })
      kernel.setState({ a: 10 } as never, true)
      const state = kernel.getState() as unknown as Record<string, unknown>
      expect(state).toEqual({ a: 10 })
      expect('b' in state).toBe(false)
      expect('gone' in state).toBe(false)
    })

    it('replace 不写穿共享引用（批8 回归：reconcile 就地合并数组曾打穿出厂池）', () => {
      const shared = ['cc-send-button']
      const kernel = createSolidStoreKernel<{ list: string[] }>({ list: shared })
      const snapshotBefore = [...shared]
      kernel.setState({ list: [] } as never, true)
      kernel.setState({ list: ['x'] } as never, true)
      // 旧共享引用不得被就地改写（reconcile 曾按 length 逐位覆写）
      expect(shared).toEqual(snapshotBefore)
    })

    it('getInitialState 返回创建时快照；replace 回初始态后可再读', () => {
      const kernel = createSolidStoreKernel<{ v: number }>({ v: 7 })
      kernel.setState({ v: 99 })
      expect(kernel.getState().v).toBe(99)
      kernel.setState(kernel.getInitialState(), true)
      expect(kernel.getState().v).toBe(7)
    })

    it('subscribe 退订后不再通知；getState 恒为同一裸对象（structuredClone 安全）', () => {
      const kernel = createSolidStoreKernel<{ nested: { arr: number[] } }>({ nested: { arr: [1] } })
      let calls = 0
      const unsub = kernel.subscribe(() => { calls += 1 })
      kernel.setState({ nested: { arr: [1, 2] } })
      expect(calls).toBe(1)
      unsub()
      kernel.setState({ nested: { arr: [1, 2, 3] } })
      expect(calls).toBe(1)
      expect(() => structuredClone(kernel.getState())).not.toThrow()
    })
  })

  class MemoryStorage implements PersistStringStorage {
    private map = new Map<string, string>()
    getItem(key: string) { return this.map.get(key) ?? null }
    setItem(key: string, value: string) { this.map.set(key, value) }
    removeItem(key: string) { this.map.delete(key) }
    dump() { return Object.fromEntries(this.map) }
  }

  describe('二轮审查走样修复（zustand 对齐）', () => {
    it('对象形态同引用 setState 整体跳过（zustand 守卫两形态一致）', () => {
      const kernel = createSolidStoreKernel<{ v: number }>({ v: 1 })
      let calls = 0
      kernel.subscribe(() => { calls += 1 })
      kernel.setState(kernel.getState())          // 对象形态同引用 → 跳过
      kernel.setState(kernel.getState(), true)    // replace 形态同引用 → 跳过
      kernel.setState(s => s)                     // 函数形态同引用 → 跳过（既有守卫）
      expect(calls).toBe(0)
      expect(kernel.getVersion()).toBe(0)
    })

    it('writeBack 抛错不阻断 notify 循环：后续 listener 照常收到、状态已在内存生效', () => {
      const throwingStorage: PersistStringStorage = {
        getItem: () => null,
        setItem: () => { throw new Error('quota exceeded') },
        removeItem: () => {},
      }
      const kernel = createSolidStoreKernel<{ v: number }>({ v: 0 })
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        attachSolidPersist(kernel, { name: 'probe-wb', version: 1, storage: throwingStorage })
        const seen: number[] = []
        kernel.subscribe(s => seen.push(s.v))
        kernel.setState({ v: 7 })
        // 状态传播不受写盘失败影响；写回 listener 自身的异常被就地吞掉
        expect(kernel.getState().v).toBe(7)
        expect(seen).toEqual([7])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('probe-wb'), expect.any(Error))
      } finally {
        consoleSpy.mockRestore()
      }
    })

    it('migrate 返回 Promise（异步不受支持）→ 丢弃 persisted、磁盘信封保留原样、不回写', () => {
      const storage = new MemoryStorage()
      const original = JSON.stringify({ state: { v: 1, legacy: 'keep' }, version: 1 })
      storage.setItem('probe-async', original)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const kernel = createSolidStoreKernel<{ v: number }>({ v: 99 })
        attachSolidPersist(kernel, {
          name: 'probe-async', version: 2, storage,
          // 模拟将来有人写 async migrate 压过类型
          migrate: (() => Promise.resolve({ v: 1 })) as never,
        })
        // 内存保持初始态（persisted 被丢弃，未把 Promise spread 进 merge）
        expect(kernel.getState().v).toBe(99)
        // 磁盘信封保留原样——绝不能用内存初始态覆盖用户数据
        expect(storage.getItem('probe-async')).toBe(original)
      } finally {
        consoleSpy.mockRestore()
      }
    })

    it('版本错位且无 migrate → 丢弃 persisted 保持初始态（zustand「丢弃 + 告警」对齐）', () => {
      const storage = new MemoryStorage()
      storage.setItem('probe-nomig', JSON.stringify({ state: { v: 1, alienShape: true }, version: 1 }))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const kernel = createSolidStoreKernel<{ v: number }>({ v: 42 })
        let hydrated: unknown = 'unset'
        let reportedError: unknown
        attachSolidPersist(kernel, {
          name: 'probe-nomig', version: 2, storage,
          onRehydrateStorage: () => (state, error) => { hydrated = state; reportedError = error },
        })
        // 旧形状不混入内存
        expect(kernel.getState().v).toBe(42)
        expect(hydrated).toBeUndefined()
        expect(reportedError).toBeInstanceOf(Error)
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('版本错位'))
      } finally {
        consoleSpy.mockRestore()
      }
    })
  })

  describe('attachSolidPersist（zustand persist 子集）', () => {
    beforeEach(() => { localStorage.clear() })

    it('磁盘信封为 {state, version}（zustand createJSONStorage 逐字节兼容）', () => {
      const storage = new MemoryStorage()
      const kernel = createSolidStoreKernel<{ v: number; action(): void }>({ v: 1, action: () => {} })
      attachSolidPersist(kernel, { name: 'probe-a', version: 3, storage, partialize: s => ({ v: s.v }) })
      kernel.setState({ v: 5 })
      expect(JSON.parse(storage.getItem('probe-a')!)).toEqual({ state: { v: 5 }, version: 3 })
    })

    it('hydration：同版本不写盘；跨版本 migrate 后经 partialize 白名单回写', () => {
      const storage = new MemoryStorage()
      storage.setItem('probe-b', JSON.stringify({ state: { v: 1, legacy: 'x' }, version: 1 }))
      const writes: string[] = []
      const kernel = createSolidStoreKernel<{ v: number; legacy?: string }>({ v: 0 })
      attachSolidPersist(kernel, {
        name: 'probe-b', version: 2, storage,
        partialize: s => ({ v: s.v }),
        migrate: persisted => persisted as { v: number },
      })
      // 记录写回：migrate 后只应有白名单键
      writes.push(storage.getItem('probe-b')!)
      expect(JSON.parse(writes[0])).toEqual({ state: { v: 1 }, version: 2 })
      expect(kernel.getState().v).toBe(1)
    })

    it('corrupt envelope：静默放弃 hydration（内存初始态兜底），不抛出', () => {
      const storage = new MemoryStorage()
      storage.setItem('probe-c', '{not json')
      const kernel = createSolidStoreKernel<{ v: number }>({ v: 42 })
      expect(() => attachSolidPersist(kernel, { name: 'probe-c', version: 1, storage })).not.toThrow()
      expect(kernel.getState().v).toBe(42)
    })

    it('storage null（node 环境）：persist 整体 no-op', () => {
      const kernel = createSolidStoreKernel<{ v: number }>({ v: 3 })
      expect(() => attachSolidPersist(kernel, { name: 'probe-d', version: 1, storage: null })).not.toThrow()
      kernel.setState({ v: 4 })
      expect(kernel.getState().v).toBe(4)
    })
  })

  it('resolveLocalStorage：node 环境返回 null（jsdom/WebView 下返回真存储）', () => {
    // 在 node project 下 localStorage 未定义 → null；本文件若被 jsdom 环境载入则返回对象。
    const resolved = resolveLocalStorage()
    if (typeof localStorage === 'undefined') expect(resolved).toBeNull()
    else expect(resolved).not.toBeNull()
  })
})
