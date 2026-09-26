/**
 * 出厂区域数据 · 元件位置一致性守卫（#266 遗留⑦）。
 *
 * ★ 为什么需要它：出厂区域数据（`src/zones/factory/**`，50 条）的生成脚本已随预设组装线刀3
 *   删除 —— 这批值**不能再生成**；而**定义表**（`domains/cc/widgetDefinitions.ts` 每行的
 *   `layout`）已经是元件位置的唯一真值。两者之间原本没有任何"与真值一致"的机器检查：
 *   只改一边（定义表改了、数据忘了改，或反过来）**不会报错**，只会静默漂移。
 *
 * 本文件把「数据 ↔ 定义表」这条判据钉住（判据落在两者之间，不是复制一份期望值）：
 * - 出厂条目携带的每个元件位置，`order` / `offsetX` / `offsetY` 必须逐项等于定义表派生出的
 *   `DEFAULT_CC_LAYOUT`；
 * - 携带位置的条目，元件 id 集合必须 = 可拖元件全集（`CC_WIDGET_IDS` + 注册轨的发送按钮）；
 * - 同一**落脚处**（`ccWidgetLanding`）内序号**不得重复** —— 撞号后渲染顺序只能靠"表里的先后"
 *   兜着，这条断言把那种隐性依赖挡在门外。
 *
 * ★ 豁免**只有一处，且显式写在下面**（`EXPECTED_CARRIERS`）：未携带 `ccLayout` 的出厂条目是
 *   **部分切片**（其来源预设本身就没写这些字段 ⇒ 装配时该字段回默认），不是"故意用不同排布"。
 *   **没有任何条目被允许声明与定义表不同的排布** —— 谁要这么做，先在这里写明理由。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CC_LAYOUT, type CcLayoutWidgetId } from '../../domains/cc/ccLayoutState.ts'
import { CC_REGISTERED_SLOT_IDS, CC_WIDGET_IDS, ccWidgetLanding } from '../../domains/cc/widgetDefinitions.ts'
import { FACTORY_ZONE_PRESET_ENTRIES, type ZonePresetEntry } from '../index.ts'

/** 携带 `ccLayout` 的出厂条目 = 需要接受位置校验的那些（其余条目没有位置可校） */
function ccLayoutCarriers(): ZonePresetEntry[] {
  return FACTORY_ZONE_PRESET_ENTRIES.filter(entry => entry.values.ccLayout !== undefined)
}

function entryKey(entry: ZonePresetEntry): string {
  return `${entry.mode}/${entry.zone}/${entry.id}`
}

function placementsOf(entry: ZonePresetEntry): Record<string, Record<string, unknown>> {
  return entry.values.ccLayout!.placements as unknown as Record<string, Record<string, unknown>>
}

/**
 * ★ 白名单（显式列出，**不许静默跳过**）—— 出厂数据里携带 `ccLayout` 的恰好这 6 条：
 * terminal 桶 5 套（生成时字段补满） + gui 桶的 `solarized`。
 * gui 的 `glass` / `agent-command` / `agent-map` / `focus-flow` 是**部分切片**（来源预设没写
 * ccLayout）⇒ 它们**不携带**位置数据（装配时该字段回默认），因此不在校验范围内；
 * 这不是"允许另一套排布"，而是"这条数据里没有排布"。
 * 多一条（谁新增了 ccLayout）或一条少了（谁把 ccLayout 删了）都会让下面第一条用例变红。
 */
const EXPECTED_CARRIERS = [
  'gui/cc/solarized',
  'terminal/cc/amber',
  'terminal/cc/claude',
  'terminal/cc/matrix',
  'terminal/cc/nord',
  'terminal/cc/tokyo',
].sort()

/** 位置记录里允许出现的键：真值三项 + 槽位时代的历史键（运行时一律不读，见 `ccLayoutState.ts`） */
const POSITION_KEYS = ['order', 'offsetX', 'offsetY']
const LEGACY_KEYS = ['slot']

describe('#266 遗留⑦ · 出厂区域数据不许与定义表漂移', () => {
  it('携带 ccLayout 的条目清单 = 白名单（多一条 / 少一条都红，防静默跳过）', () => {
    expect(ccLayoutCarriers().map(entryKey).sort()).toEqual(EXPECTED_CARRIERS)
    // 反向确认这份清单没被空手放过：出厂条目共 50 条，携带者是其中一小撮
    expect(FACTORY_ZONE_PRESET_ENTRIES).toHaveLength(50)
    expect(EXPECTED_CARRIERS.length).toBeGreaterThan(0)
    expect(EXPECTED_CARRIERS.length).toBeLessThan(FACTORY_ZONE_PRESET_ENTRIES.length)
  })

  it('每个元件位置：order / offsetX / offsetY 逐项等于定义表声明（DEFAULT_CC_LAYOUT）', () => {
    let checked = 0
    for (const entry of ccLayoutCarriers()) {
      const at = entryKey(entry)
      for (const [id, placement] of Object.entries(placementsOf(entry))) {
        const declared = DEFAULT_CC_LAYOUT.placements[id as CcLayoutWidgetId]
        expect(declared, `${at} 的「${id}」不在可拖元件名单里（越名单）`).toBeTruthy()
        expect(
          { order: placement.order, offsetX: placement.offsetX, offsetY: placement.offsetY },
          `${at} 的「${id}」位置必须等于定义表声明（widgetDefinitions.ts 那一行的 layout）`,
        ).toEqual({ order: declared.order, offsetX: declared.offsetX, offsetY: declared.offsetY })
        checked += 1
      }
    }
    // 条数守恒：携带者 × 可拖元件全集 —— 少一个元件的位置也会在这里露出来
    expect(checked, '实际对拍的位置条数').toBe(EXPECTED_CARRIERS.length * Object.keys(DEFAULT_CC_LAYOUT.placements).length)
  })

  it('携带者携带的元件 id 集合 = 可拖元件全集（一个不多、一个不少）', () => {
    const expectedIds = [...CC_WIDGET_IDS, ...CC_REGISTERED_SLOT_IDS].sort()
    expect(expectedIds, '可拖元件全集 = 6 个内置轨控件 + 注册轨的发送按钮').toHaveLength(7)
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements).sort(), '默认布局的键集').toEqual(expectedIds)
    for (const entry of ccLayoutCarriers()) {
      expect(Object.keys(placementsOf(entry)).sort(), `${entryKey(entry)} 的元件 id 集合`).toEqual(expectedIds)
    }
  })

  it('位置记录只带 order / offsetX / offsetY（+ 历史 slot）：多出别的键（gap / anchor / side…）必须先在这里登记并与定义表对拍', () => {
    const allowed = [...POSITION_KEYS, ...LEGACY_KEYS]
    for (const entry of ccLayoutCarriers()) {
      const at = entryKey(entry)
      for (const [id, placement] of Object.entries(placementsOf(entry))) {
        expect(Object.keys(placement).filter(key => !allowed.includes(key)), `${at} 的「${id}」出现未登记的位置键`).toEqual([])
      }
    }
  })

  it('同一落脚处内序号不得重复（撞号 ⇒ 渲染顺序只能靠表序兜着，不许留这种隐性依赖）', () => {
    for (const entry of ccLayoutCarriers()) {
      const at = entryKey(entry)
      const byLanding = new Map<string, { id: string; order: number }[]>()
      for (const [id, placement] of Object.entries(placementsOf(entry))) {
        const landing = ccWidgetLanding(id)
        expect(landing, `${at} 的「${id}」没有落脚处（定义表缺 layout？）`).toBeTruthy()
        const bucket = byLanding.get(landing!)
        const item = { id, order: placement.order as number }
        if (bucket) bucket.push(item)
        else byLanding.set(landing!, [item])
      }
      // 反向确认分组没被空手放过：两个信息落点 + 悬浮件自己那一个
      expect([...byLanding.keys()].sort(), `${at} 的落脚处`).toEqual(['cc-surface:bottom', 'cc-surface:top', 'input:center'])
      for (const [landing, items] of byLanding) {
        expect(new Set(items.map(item => item.order)).size, `${at} 落脚处 ${landing} 内序号撞号：${items.map(item => `${item.id}=${item.order}`).join(' / ')}`)
          .toBe(items.length)
      }
    }
  })
})
