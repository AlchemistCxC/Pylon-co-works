import { unwrap } from 'solid-js/store'
import { createStore, produce } from 'solid-js/store'

/**
 * Solid store 内核（#515 前端全量 Solid 化批0）：zustand 运行时的就地置换件。
 *
 * 各域 store 的状态本体从 zustand `create` 换成 `solid-js/store` 细粒度 store，
 * 但对外**保 zustand 门面签名**（getState / setState(partial, replace?) / subscribe /
 * getInitialState + hook 形态经同目录 reactStoreShim 暂供 React 面使用）——消费者
 * 在组件迁移批内零改动，终态 React 面退役后 shim 与本门面一并收敛为直连。
 *
 * 语义对齐点（zustand v5 vanilla）：
 * - `setState(partial)` 浅合并；函数形态的 updater **返回当前 state 同一引用时整体跳过**
 *   （不合并、不通知）；合并后必产新通知（无值级判等——与 zustand 一致，判等在消费侧）。
 * - `setState(next, true)` 整体替换（resetStores 的 `setState(getInitialState(), true)` 依赖）。
 * - `subscribe(listener)` 收 `(state, prevState)`；⚠️ prevState 与 state 同一引用且为**写后值**
 *   （produce/reconcile 就地改写裸对象，无写前快照）——不要拿它做 diff，zustand 语义在此不成立。
 * - `getInitialState()` 返回**创建时的初始对象**（浅捕获；嵌套对象与 zustand 一样
 *   不做深拷贝——写入方各自负责 clone，见 themeStore resetTheme 的 structuredClone）。
 * - 状态本体是 Solid store 代理：引用跨写入稳定，读取方拿到的代理可当不可变快照用
 *   （一切写入必须经 action 的 set，代理外无写通道）。
 */

export interface SolidStoreKernel<T extends object> {
  /** zustand `getState()` 等价：当前状态（Solid store 代理）。 */
  getState: () => T
  /** zustand `setState(partial | updater, replace?)` 等价。 */
  setState: (partial: Partial<T> | ((state: T) => Partial<T>), replace?: boolean) => void
  /** zustand `subscribe(listener)` 等价；listener 收 `(state, prevState)`。 */
  subscribe: (listener: (state: T, prevState: T) => void) => () => void
  /** zustand `getInitialState()` 等价：创建时的初始状态对象。 */
  getInitialState: () => T
  /** 通知计数（每次 set 单调 +1）——React shim 以它判「快照是否过期」。 */
  getVersion: () => number
  /** Solid store 代理本体（终态直连用；过渡期与 getState() 同一对象）。 */
  readonly state: T
}

export function createSolidStoreKernel<T extends object>(initial: T): SolidStoreKernel<T> {
  const [state, setState] = createStore<T>(initial)
  const initialState = { ...initial }
  const listeners = new Set<(state: T, prevState: T) => void>()
  // current = unwrap 后的裸对象树：getState() 的消费者（纯 reducer、structuredClone、
  // 旧 React 面）拿到的是普通对象（zustand 同款），不会漏出不可克隆的 Solid 代理。
  // 一切写入仍走 setState（produce/reconcile 改写同一裸对象），`state` 代理照常响应。
  const current = unwrap(state) as T
  let version = 0

  const notify = (prev: T) => {
    version += 1
    for (const listener of [...listeners]) listener(current, prev)
  }

  const kernel: SolidStoreKernel<T> = {
    getState: () => current,
    setState: (partial, replace) => {
      const next = typeof partial === 'function' ? partial(current) : partial
      // zustand 同款：函数 updater 返回当前 state 同一引用 ⇒ 整体跳过（不写、不通知）。
      if (Object.is(next, current) && typeof partial === 'function') return
      // ★ replace 不得用 `reconcile`：reconcile 为了细粒度更新会**就地合并旧树的嵌套
      //   数据**（数组走 `setProperty(previous, 'length', …)` 逐位覆写）——旧状态里的
      //   嵌套对象/数组可能藏着**调用方自有引用**（zustand 时代一直如此共享：出厂区域
      //   预设池的 `values` 数组经 `effectivePresetTheme`/`filterPresetTheme` 浅拷贝进
      //   state；hydration merge 的 `...current` 还会把 `DEFAULTS` 的数组铺进初始树）。
      //   就地改写等于把这些外部数据打穿（#515 定位：defaultPresets「铁律1」在批0 后
      //   必红的根因——resetStores 一跑，出厂池的 ccHidden 数组被清空）。zustand v5 的
      //   replace 从不改写旧状态 ⇒ 这里用 produce 逐键**整键换入**（数组/对象按引用整
      //   替，solid 对非 merge 赋值不做就地合并），并删除 next 缺席的键（replace=整体
      //   置换语义），旧树除根属性引用外零触碰；代理身份照旧稳定。
      setState(produce(s => {
        const target = s as Record<string, unknown>
        const patch = next as Record<string, unknown>
        if (replace) {
          for (const key of Object.keys(target)) {
            if (!(key in patch)) delete target[key]
          }
        }
        Object.assign(target, patch)
      }))
      notify(current)
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getInitialState: () => initialState,
    getVersion: () => version,
    state,
  }
  return kernel
}

/** solidStoreBridge 兼容的最小结构面（ getState/subscribe 双件套）。 */
export interface ZustandStoreLike<T> {
  getState: () => T
  subscribe: (listener: (state: T) => void) => () => void
}

/** zustand persist 的字符串存储接口（createJSONStorage 包一层前的形状）。 */
export interface PersistStringStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/**
 * localStorage 安全解析（createJSONStorage(() => localStorage) 的等价惰性 + 吞异常）：
 * node 测试环境无 localStorage ⇒ 返回 null ⇒ persist 整体 no-op（zustand 同款），
 * jsdom / WebView2 / 浏览器 mock 下返回真存储。
 */
export function resolveLocalStorage(): PersistStringStorage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

export interface SolidPersistOptions<T extends object> {
  /** zustand persist `name`：localStorage 键。 */
  name: string
  version?: number
  /** null = 存储不可用（node 测试环境），persist 整体 no-op。 */
  storage: PersistStringStorage | null
  partialize?: (state: T) => Partial<T>
  /** 缺省 `{ ...current, ...persisted }`（zustand 默认 merge）。 */
  merge?: (persisted: unknown, current: T) => T
  /** 版本不一致时的一次性语义迁移；跑过必回写一次（zustand 同款行为）。 */
  migrate?: (persisted: unknown, version: number | undefined) => T | Partial<T>
  onRehydrateStorage?: () => (state?: T, error?: unknown) => void
}

/**
 * zustand `persist` 中间件的本仓子集复刻（#515 批0）。
 *
 * 只实现本仓实际用到的语义，磁盘信封**逐字节兼容** zustand createJSONStorage 的
 * `{"state":…,"version":N}`——存量 localStorage 条目原地可读，无一次性搬家：
 * - 读到合法信封 → 版本不一致走 `migrate` 并**回写一次**；一致则只落 `merge`；
 * - hydrate 落盘走 merge 后的整份状态但**不触发写盘**（先 hydrate 后挂写回订阅）；
 * - 写回在每次 set 通知后同步执行（zustand 同款：resetStores 依赖同步落盘），
 *   载荷经 `partialize` 白名单（缺省整份状态，函数成员被 JSON.stringify 自然丢弃）。
 * - 解析失败：**静默**放弃 hydration（zustand 同款，错误经 onRehydrateStorage 的 error 位可见），内存初始态兜底。
 */
export function attachSolidPersist<T extends object>(kernel: SolidStoreKernel<T>, options: SolidPersistOptions<T>): void {
  // 存储不可用（node 测试环境）⇒ 整体 no-op，内存态兜底（zustand createJSONStorage 同款）。
  const storage = options.storage
  if (!storage) return
  const version = options.version ?? 0
  // 写回**同步且不吞异常**（zustand 同款：setItem 异常从 setState 调用栈原样抛出，
  // resetStores 等调用方自行 try/catch；自管可见化的存储在 setItem 内已报错）。
  const writeBack = (state: T) => {
    const payload = options.partialize ? options.partialize(state) : state
    storage.setItem(options.name, JSON.stringify({ state: payload, version }))
  }

  // —— hydration（同步存储 ⇒ 全程同步，与 zustand toThenable 的同步路径一致）——
  // 读盘/解析失败走 zustand 同款静默路径：错误经 onRehydrateStorage 的 error 位可见，
  // 内存初始态兜底（customPresetStore 的搬家读等消费方依赖「corrupt envelope 不炸不响」）。
  let hydrated = false
  let hydrateError: unknown
  try {
    const raw = storage.getItem(options.name)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { state?: unknown; version?: number } | null
      const persisted = (parsed && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed) as unknown
      const storedVersion = parsed && typeof parsed === 'object' ? (parsed as { version?: number }).version : undefined
      let migrated: unknown = persisted
      let didMigrate = false
      if (storedVersion !== version && options.migrate) {
        migrated = options.migrate(persisted, storedVersion)
        didMigrate = true
      }
      const current = kernel.getState()
      const merged = options.merge
        ? options.merge(migrated, current)
        : { ...current, ...(migrated as Partial<T>) }
      kernel.setState(merged, true)
      hydrated = true
      if (didMigrate) {
        // zustand 同款：migrate 后的回写走**正常写回路径**（经 partialize 白名单）。
        writeBack(kernel.getState())
      }
    }
  } catch (error) {
    hydrateError = error
  }
  options.onRehydrateStorage?.()(hydrated ? kernel.getState() : undefined, hydrateError)

  kernel.subscribe(state => writeBack(state))
}
