// @vitest-environment jsdom
/**
 * #238 刀2 · 读盘路径的端到端证据（真实 zustand persist 水合）。
 *
 * 纯函数层的等价性/幂等见 `structuralAlignment.test.ts`；这里证明的是**挂钩**：
 * 结构对齐确实挂在 `store.ts` 的 persist `merge` 上、**每次读盘无条件跑**
 * —— 包括「持久化版本号与当前版本相同」这种**migrate 根本不跑**的情况
 * （那正是历史上"忘了 bump 就静默坏"的场景）。
 */
import { describe, expect, it, vi } from 'vitest'
import { THEME_SCHEMA_VERSION } from '../migration.ts'
import { DEFAULTS } from '../themeDefaults.ts'

const STORAGE_KEY = 'pylon-theme'
// ★ 种子里**故意留着 legacy `slot`**（老数据的真实形状）：#238 刀3 起读盘一律不读它，
// 所以持久化进去的 `slot` 不会出现在 store 状态里（下面的期望据此写成 slot-less）。
const USER_PLACEMENT = { slot: 'status-secondary', order: 7, offsetX: 12, offsetY: -3 }
const USER_EXPECTED = { order: 7, offsetX: 12, offsetY: -3 }

type Booted = {
  state: Record<string, unknown>
  layout: { version: number; placements: Record<string, typeof USER_PLACEMENT> }
  raw: string | null
}

/** 每次都在**全新模块图**上启动：先把种子写进 localStorage，再 import store（触发水合）。 */
async function bootWithPersisted(persisted: { state: Record<string, unknown>; version: number } | null): Promise<Booted> {
  vi.resetModules()
  localStorage.clear()
  let raw: string | null = null
  if (persisted) {
    raw = JSON.stringify(persisted)
    localStorage.setItem(STORAGE_KEY, raw)
  }
  const { useStore } = await import('../../../store.ts')
  const state = useStore.getState() as unknown as Record<string, unknown>
  return { state, layout: state.ccLayout as Booted['layout'], raw }
}

describe('#238 刀2 · 读盘后无条件结构对齐（版本号相同、migrate 不跑，也要对齐）', () => {
  it('缺 reasoning 项被补齐，用户手调的 offset/order 与已设字段原样保留', async () => {
    const { state, layout } = await bootWithPersisted({
      // 老浏览器里存下的清单：只有 model 一项
      state: {
        ccLayout: { version: 9, placements: { model: { ...USER_PLACEMENT } } },
        ccHidden: ['tokens'],
        ccHeight: 220,
        modelWidth: 150,
      },
      // ★ 与当前版本**相同** ⇒ zustand 不调用 migrate ⇒ 对齐只可能来自 merge 钩子
      version: THEME_SCHEMA_VERSION,
    })

    expect(Object.keys(layout.placements).sort()).toEqual(['cc-send-button', 'input', 'mode', 'model', 'reasoning', 'tokens'])
    expect(layout.placements.reasoning).toMatchObject({ order: 2 })
    // 用户值一样都没动（不拍平）
    expect(layout.placements.model).toEqual(USER_EXPECTED)
    expect(state.ccHeight).toBe(220)
    expect(state.modelWidth).toBe(150)
    expect(state.ccHidden).toEqual(['tokens'])
  })

  it('对齐不产生写盘 / 不触发额外广播（版本号相同 ⇒ localStorage 里那串字节一字节未变）', async () => {
    const { raw } = await bootWithPersisted({
      state: { ccLayout: { version: 9, placements: { model: { ...USER_PLACEMENT } } } },
      version: THEME_SCHEMA_VERSION,
    })
    // 若对齐走的是「发现差异就 setState 写回」，这里会看到被重写过的 JSON（补上了 reasoning）
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })
})

describe('#238 刀2 · 版本号不匹配时仍是「迁移 + 对齐」，用户值同样保留', () => {
  it('版本 7（发布过、曾被白名单漏掉）⇒ 不再整份重置，位置保留且缺项补齐', async () => {
    const { state, layout } = await bootWithPersisted({
      state: {
        ccLayout: { version: 7, placements: { model: { ...USER_PLACEMENT } } },
        ccHeight: 220,
      },
      version: 7,
    })

    expect(layout.placements.model).toEqual(USER_EXPECTED)
    expect(layout.placements.reasoning).toMatchObject({ order: 2 })
    expect(layout.version).toBe(9)
    // migrate 真的跑过 ⇒ 这一支会写盘（与刀2 之前一致：只在版本变化时写）
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').version).toBe(THEME_SCHEMA_VERSION)
    expect(state.ccHeight).toBe(220)
  })
})

describe('#238 刀2 · 干净新装 ⇒ 与今天逐字段相同', () => {
  it('无持久化数据时，store 初值落在既有 DEFAULTS 上', async () => {
    const { state, raw } = await bootWithPersisted(null)
    expect(raw).toBeNull()
    for (const key of Object.keys(DEFAULTS)) {
      expect(state[key], `DEFAULTS.${key}`).toEqual((DEFAULTS as unknown as Record<string, unknown>)[key])
    }
    expect((state.ccLayout as Booted['layout']).placements)
      .toEqual((DEFAULTS.ccLayout as unknown as Booted['layout']).placements)
  })
})
