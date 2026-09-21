// @vitest-environment jsdom
/**
 * 刀2（#223 · 预设组装）：**出厂区域预设独立成数据**。
 *
 * 五条一起锁：
 * - **B1** 落盘数据 == 现场派生参考（50 条 × 全部字段逐条 `toEqual`，不是抽样），且池里的条目
 *   就是数据表里的那些**对象本身**（数据表是活数据源，不是被绕过的备份）；
 * - **B2** 出厂条目**不可删**（判据 `origin`、UI 不出删除入口、删除 reducer 是 no-op）；
 * - **B3** 出厂条目**不进** `zonePresetEntries`（用户不可删的结构性闸门）；
 * - **B4** 刀1 的区域引用解析**仍通**，且取到的值就是数据里的那份 `values`；
 * - **B5** 出厂数据里的**越区键报错**（不是静默丢弃）；
 * - **B6** **无折叠**（规范 §7 刀2「裁决 A」）：同形也各留一条、id 恒等于各自来源预设名。
 *
 * ★ 基线对拍用的「现场派生参考」= `deriveZonePresetPool` / `pickZoneFields`（刀2 起退为参考实现，
 * 只给生成脚本与本文件用）；外部基线是备份存档
 * `预设修正/备份/预设组装-前存档-20260921/`（与本文件的派生参考逐字节一致，见开发记录）。
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GLOBAL_PRESETS, type GlobalPreset } from '../../presets/index.ts'
import { PRESET_ZONES, requireZoneRefs } from '../../domains/theme/presetReducer.ts'
import { expandGlobalPresetZoneRefs } from '../../application/transactions/applyGlobalPreset.ts'
import { DEFAULTS } from '../../domains/theme/themeDefaults.ts'
import { useStore } from '../../store.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.tsx'
import { resetStores } from '../../test/resetStores.ts'
import {
  FACTORY_ZONE_PRESET_ENTRIES,
  ZONE_PRESET_POOL,
  assembleFactoryZonePresetPool,
  deriveZonePresetPool,
  isCustomZonePresetEntry,
  pickZoneFields,
  removeZonePresetEntryReducer,
  resolveZonePresetEntryTheme,
  zonePresetsFor,
  type ZonePresetEntry,
} from '../index.ts'

vi.mock('../../components/settings/AgentRuntimePanel.tsx', () => ({ default: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const BUCKETS = ['gui', 'terminal'] as const

function bucketPresetNames(mode: (typeof BUCKETS)[number]): string[] {
  return GLOBAL_PRESETS.filter(preset => preset.interfaceMode === mode).map(preset => preset.name)
}

function presetGroup(): HTMLElement {
  return screen.getByText('局部预设').closest('.set-group') as HTMLElement
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
  useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
})

// ── B1 数据 == 派生参考 ────────────────────────────────────────────

describe('B1 落盘数据 == 现场派生参考（50 条逐字段）', () => {
  it('50 条 × 每条全部字段与 pickZoneFields(来源预设.theme, zone) 逐字段相等', () => {
    expect(FACTORY_ZONE_PRESET_ENTRIES).toHaveLength(50)
    let checked = 0
    for (const entry of FACTORY_ZONE_PRESET_ENTRIES) {
      const at = `${entry.mode}/${entry.zone}/${entry.id}`
      const preset = GLOBAL_PRESETS.find(candidate => candidate.name === entry.id)
      expect(preset, `${at} 来源预设必须存在（id = 来源预设名）`).toBeTruthy()
      expect(entry.origin, `${at} 出厂数据必须显式标 factory`).toBe('factory')
      expect(entry.source?.presetName, `${at} 来源可追溯`).toBe(entry.id)
      expect(entry.values, `${at} 全部字段`).toEqual(pickZoneFields(preset!.theme, entry.zone))
      checked += 1
    }
    expect(checked, '实际逐条对拍条数').toBe(50)
  })

  it('★ 数据表是活数据源：池里的条目就是数据表里的那些对象（不是重算出的副本）', () => {
    for (const mode of BUCKETS) {
      for (const zone of PRESET_ZONES) {
        for (const entry of ZONE_PRESET_POOL[mode][zone]) {
          expect(FACTORY_ZONE_PRESET_ENTRIES, `${mode}/${zone}/${entry.id} 必须是数据表里的同一对象`).toContain(entry)
        }
      }
    }
  })

  it('每格条数 == 该桶预设数，且候选恰好是该格出厂条目（顺序 = 桶内预设顺序）', () => {
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        expect(ZONE_PRESET_POOL[mode][zone], `${mode}/${zone} 条数`).toHaveLength(names.length)
        expect(ZONE_PRESET_POOL[mode][zone].map(entry => entry.id), `${mode}/${zone} 顺序`).toEqual(names)
      }
    }
  })
})

// ── B2 出厂条目不可删 ─────────────────────────────────────────────

describe('B2 出厂条目不可删', () => {
  it('判据（origin）对全部 50 条出厂条目一律为「非自定义」', () => {
    for (const entry of FACTORY_ZONE_PRESET_ENTRIES) {
      expect(isCustomZonePresetEntry(entry), `${entry.mode}/${entry.zone}/${entry.id}`).toBe(false)
    }
  })

  it('删除 reducer 传出厂预设名是 no-op（不动条目、不写标记）', () => {
    const state = {
      zonePresetEntries: [] as ZonePresetEntry[],
      appliedPreset: { ...DEFAULTS.appliedPreset },
      custom: { ...DEFAULTS.custom },
    }
    const patch = removeZonePresetEntryReducer(state, 'glass')
    expect(patch.zonePresetEntries, '未命中 ⇒ 原引用返回').toBe(state.zonePresetEntries)
    expect(patch.appliedPreset, '未命中 ⇒ 不写状态').toBeUndefined()
    expect(patch.custom).toBeUndefined()
  })

  it('UI：出厂 chip 被选中也不出删除入口（判据没被 values 接管）', () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(presetGroup())
    fireEvent.click(group.getByRole('button', { name: 'Glass Light' }))
    expect(group.queryAllByRole('button', { name: '删除' })).toHaveLength(0)
  })

  it('判据没有把两方都吞掉：自定义条目仍判为自定义，且入池时被显式标 custom', () => {
    const custom: ZonePresetEntry = {
      id: 'zone-gui-sidebar-1', mode: 'gui', zone: 'sidebar', label: '我的侧栏',
      values: { sidebarBg: '#123456' },
    }
    expect(isCustomZonePresetEntry(custom), '没有 origin ⇒ 按自定义').toBe(true)
    const [inPool] = zonePresetsFor('modern-gui', 'sidebar', [custom]).filter(entry => entry.id === custom.id)
    expect(inPool.origin, '持久化通道里的一律标 custom').toBe('custom')
    expect(isCustomZonePresetEntry(inPool)).toBe(true)
  })
})

// ── B3 出厂条目不进 zonePresetEntries ─────────────────────────────

describe('B3 出厂条目不进 zonePresetEntries（结构性闸门）', () => {
  it('存/删自定义条目的整条流程跑完，50 条出厂条目始终不在该数组里', () => {
    const factoryIds = new Set(FACTORY_ZONE_PRESET_ENTRIES.map(entry => entry.id))
    expect(factoryIds.size, '出厂条目 id 去重后 = 10 套预设名').toBe(10)

    const assertNoFactoryIds = (stage: string) => {
      for (const entry of useStore.getState().zonePresetEntries) {
        expect(factoryIds.has(entry.id), `${stage}：出厂条目 ${entry.id} 混进了用户条目数组`).toBe(false)
      }
    }

    assertNoFactoryIds('起点')
    useStore.getState().setZoneField('sidebar', { sidebarBg: '#123456' })
    const id = useStore.getState().saveZonePresetEntry('gui', 'sidebar', '我的侧栏')!
    expect(useStore.getState().zonePresetEntries.map(entry => entry.id)).toEqual([id])
    assertNoFactoryIds('存之后')

    useStore.getState().removeZonePresetEntry(id)
    expect(useStore.getState().zonePresetEntries).toHaveLength(0)
    assertNoFactoryIds('删之后')
  })
})

// ── B4 引用解析仍通 ───────────────────────────────────────────────

describe('B4 刀1 的区域引用解析仍通（10 套 × 5 区域）', () => {
  it('全部解析成功，取到的值 = 现场派生切片，且就是数据里的那份 values', () => {
    for (const preset of GLOBAL_PRESETS) {
      const refs = requireZoneRefs(preset.zoneRefs, preset.name)
      const slices = expandGlobalPresetZoneRefs(preset.interfaceMode, refs)
      expect(slices.map(slice => slice.zone), `${preset.name} 区域覆盖`).toEqual([...PRESET_ZONES])
      for (const slice of slices) {
        const at = `${preset.name}/${slice.zone}`
        // 与刀1 那一刻的切片（现场派生）逐字段相同
        expect(slice.theme, `${at} 等于派生切片`).toEqual(pickZoneFields(preset.theme, slice.zone))
        // 且来源是落盘数据里的那份 values（同一个对象 ⇒ 生产路径没有回头重算）
        const entry = ZONE_PRESET_POOL[preset.interfaceMode][slice.zone].find(candidate => candidate.id === slice.presetName)!
        expect(entry, `${at} 池里必须能解析到 ${slice.presetName}`).toBeTruthy()
        expect(slice.theme, `${at} 就是数据里的 values`).toBe(resolveZonePresetEntryTheme(entry))
      }
    }
  })
})

// ── B5 越区键报错 ─────────────────────────────────────────────────

describe('B5 出厂数据里的越区键必须报错（不是静默丢弃）', () => {
  it('真实数据装配为池不报错', () => {
    expect(() => assembleFactoryZonePresetPool(FACTORY_ZONE_PRESET_ENTRIES)).not.toThrow()
  })

  it('往 cc 区域塞一个左栏字段 ⇒ 构造期抛错，且报出越区键名', () => {
    const poisoned: ZonePresetEntry = {
      id: 'glass', mode: 'gui', zone: 'cc', label: '毒条目', origin: 'factory',
      values: { ccBg: '#000000', sidebarBg: '#000000' },
    }
    expect(() => assembleFactoryZonePresetPool([poisoned])).toThrow(/越区/)
    expect(() => assembleFactoryZonePresetPool([poisoned])).toThrow(/sidebarBg/)
  })
})

// ── B6 无折叠 ─────────────────────────────────────────────────────

describe('B6 无折叠（规范 §7 刀2「裁决 A」）', () => {
  it('每格条目 id 恰好等于桶内预设名——同形也各留一条，池里不再有 sources', () => {
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        const cell = ZONE_PRESET_POOL[mode][zone]
        // 折叠若复活：同形的另一条会被折进来 ⇒ 少了 id ⇒ 该套预设的 zoneRefs 解析不到
        expect(cell.map(entry => entry.id), `${mode}/${zone} 每套预设各留一条`).toEqual(names)
        for (const entry of cell) expect(entry, `${mode}/${zone}/${entry.id}`).not.toHaveProperty('sources')
      }
    }
  })

  it('合成两块同形切面：仍是 2 条，各自 id = 各自的来源预设名', () => {
    const twins: GlobalPreset[] = [
      // 内容同形、字段书写顺序不同（键序无关的老要求仍在）
      { name: 'nord', label: '双胞胎甲', interfaceMode: 'gui', theme: { sidebarBg: '#111', sidebarNameSize: 14 } },
      { name: 'tokyo', label: '双胞胎乙', interfaceMode: 'gui', theme: { sidebarNameSize: 14, sidebarBg: '#111' } },
    ]
    const pool = deriveZonePresetPool(twins)
    expect(pool.gui.sidebar).toHaveLength(2)
    expect(pool.gui.sidebar.map(entry => entry.id)).toEqual(['nord', 'tokyo'])
    expect(pool.gui.sidebar.map(entry => entry.label)).toEqual(['双胞胎甲', '双胞胎乙'])
    for (const entry of pool.gui.sidebar) {
      expect(entry.source, '来源仍可追溯').toEqual({ presetName: entry.id })
      expect(entry.values).toEqual({ sidebarBg: '#111', sidebarNameSize: 14 })
      expect(entry).not.toHaveProperty('sources')
    }
  })
})
